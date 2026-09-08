/**
 * 浏览器侧录音 → 16k 单声道 PCM WAV
 *
 * 为什么不用 MediaRecorder：它出的是 webm/opus，而 sherpa 只吃 WAV PCM，
 * 服务端本机**没有 ffmpeg** 解不了。所以只能在这里自己采、自己封头。
 *
 * 为什么 16k 直采而不是事后重采样：字节少 3 倍、上传快，而且 sherpa 收到 16k
 * 就不会每次调用往 stderr 刷一段 C++ `Creating a resampler`。
 *
 * 为什么用 ScriptProcessor 而不是 AudioWorklet：worklet 要一个额外的产物文件
 * （vite 下得 `?url` import 才能拿到 URL），而本用例每秒约 4 次、每次 16KB 的拷贝
 * 根本不构成主线程压力。Chromium 只是标了废弃、没有移除计划。
 */

/** SenseVoice 的目标采样率；也是上传体积的算术基准（16k × 16bit × mono = 32,000 B/s） */
export const TARGET_RATE = 16000

export interface Recording {
  /** 可直接 POST 给 /api/asr 的 WAV 字节 */
  wav: ArrayBuffer
  seconds: number
  /** 全程最大振幅 0..1，用来判断「其实没听到声音」 */
  peak: number
  sampleRate: number
  /** 撞到 maxSeconds 上限被自动停的 */
  capped: boolean
}

export interface RecordHandle {
  stop(): Promise<Recording>
  cancel(): void
}

export type RecorderFailure = 'not_secure' | 'denied' | 'unsupported' | 'busy'

export class RecordError extends Error {
  code: RecorderFailure
  constructor(code: RecorderFailure, message: string) {
    super(message)
    this.code = code
    this.name = 'RecordError'
  }
}

function writeAscii(dv: DataView, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i))
}

/**
 * 纯函数：Int16 分块 → canonical WAV（44 字节头 + PCM）。
 * 单独导出是为了能自证 —— devtools 里喂 `encodeWav([new Int16Array([1,-1,0])], 16000)`
 * 就能核对头 12 字节 `RIFF … WAVE`、采样率 16000、byteRate 32000、位深 16。
 */
export function encodeWav(chunks: Int16Array[], sampleRate: number): ArrayBuffer {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const dataBytes = total * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)

  writeAscii(dv, 0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  writeAscii(dv, 8, 'WAVE')
  writeAscii(dv, 12, 'fmt ')
  dv.setUint32(16, 16, true) // fmt chunk 长度
  dv.setUint16(20, 1, true) // 1 = PCM，不是 IEEE float
  dv.setUint16(22, 1, true) // 单声道
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byteRate = rate × blockAlign
  dv.setUint16(32, 2, true) // blockAlign = 声道 × 字节
  dv.setUint16(34, 16, true) // 位深
  writeAscii(dv, 36, 'data')
  dv.setUint32(40, dataBytes, true)

  let off = 44
  for (const c of chunks) {
    // 直接映射到 buf 上写，省掉一次中间大数组
    new Int16Array(buf, off, c.length).set(c)
    off += c.length * 2
  }
  return buf
}

/**
 * Float32 → Int16。
 * 取整必须 `-1 → -32768`：写成 `v * 0x8000 | 0` 之前不 clamp，正峰会溢出到 -32768。
 */
function toInt16(samples: Float32Array): { pcm: Int16Array; peak: number } {
  const pcm = new Int16Array(samples.length)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0
    const a = s < 0 ? -s : s
    if (a > peak) peak = a
  }
  return { pcm, peak }
}

/** 线性插值降采样。设备不给 16k 时才走这条路（多数浏览器会直接接受 sampleRate:16000） */
function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input
  const out = new Float32Array(Math.floor((input.length * TARGET_RATE) / fromRate))
  const step = fromRate / TARGET_RATE
  for (let i = 0; i < out.length; i++) {
    const p = i * step
    const i0 = Math.floor(p)
    const i1 = Math.min(i0 + 1, input.length - 1)
    out[i] = input[i0] + (input[i1] - input[i0]) * (p - i0)
  }
  return out
}

/** 把 getUserMedia 的异常分型成可读原因 —— 别和「模型没装」混成一句 */
function classify(e: unknown): RecordError {
  const name = (e as { name?: string })?.name ?? ''
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return new RecordError('unsupported', '这个浏览器没有语音识别 API')
  }
  if (!window.isSecureContext) {
    return new RecordError('not_secure', '录音需要 https 或 localhost（当前不是安全上下文）')
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecordError('denied', '麦克风权限被拒（浏览器地址栏左侧可改）')
  }
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') {
    return new RecordError('busy', '麦克风被别的程序占用，或没有可用设备')
  }
  return new RecordError('unsupported', `无法开始录音：${name || String(e)}`)
}

export async function startRecording(opts?: {
  maxSeconds?: number
  onLevel?: (peak: number) => void
  /**
   * 撞到 maxSeconds 时通知调用方来取结果。
   * 不加这个回调，15 秒上限就成了「录完了没人收尾」——用户以为还在录。
   */
  onAutoStop?: () => void
}): Promise<RecordHandle> {
  const maxSeconds = opts?.maxSeconds ?? 15

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
  } catch (e) {
    throw classify(e)
  }

  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE })
  } catch {
    ctx = new AudioContext() // 个别设备拒绝指定采样率 → 原生率采集，事后插值到 16k
  }
  const nativeRate = ctx.sampleRate

  const src = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)

  const chunks: Int16Array[] = []
  let total = 0
  let dropped = 0
  let peak = 0
  let halted = false
  let capped = false

  // Chrome 下 ScriptProcessor 不连到 destination 就不会回调；
  // 但直连会把麦克风原样放出来（啸叫），所以垫一个 gain=0 的节点。
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(ctx.destination)

  node.onaudioprocess = (ev: AudioProcessingEvent) => {
    if (halted) return
    // 只丢首个预热帧（多数浏览器给的是全零）。不再多丢：peak 取的是最大值，
    // 静音帧不会稀释它，而每帧 4096/16000≈256ms，丢两帧会把「查一下」的「查」吃掉。
    if (dropped < 1) {
      dropped++
      return
    }
    const input = ev.inputBuffer.getChannelData(0) // 只读视图，跨回调必须拷贝
    const { pcm, peak: p } = toInt16(resample(input, nativeRate))
    chunks.push(pcm)
    total += pcm.length
    if (p > peak) peak = p
    opts?.onLevel?.(peak)
    if (total / TARGET_RATE >= maxSeconds) {
      capped = true
      halt() // 数据留着，等调用方 stop() 来取
      opts?.onAutoStop?.()
    }
  }

  function halt(): void {
    halted = true
    try {
      node.disconnect()
      src.disconnect()
      sink.disconnect()
    } catch {
      /* 已经断过 */
    }
  }

  /** 一定都要关：漏一个就是系统麦克风指示灯长亮 */
  function release(): void {
    halt()
    stream.getTracks().forEach((t) => t.stop())
    ctx.close().catch(() => {})
  }

  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})

  return {
    async stop() {
      halt()
      const wav = encodeWav(chunks, TARGET_RATE)
      const seconds = total / TARGET_RATE
      const maxPeak = peak
      release()
      return { wav, seconds, peak: maxPeak, sampleRate: TARGET_RATE, capped }
    },
    cancel() {
      chunks.length = 0
      release()
    },
  }
}
