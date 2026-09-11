/**
 * 「耳」—— 本地 SenseVoice ASR（sherpa-onnx · 离线 · 0 网络）
 *
 * 为什么要有这只耳朵：
 *   评测脚本跑的是本地 SenseVoice，画布用的却是浏览器 Web Speech —— 两只耳朵，
 *   那份 CER 34% 就永远只是「候选引擎的分数」。本模块同时服务两边：
 *   `asr-transcribe.ts`（离线评测）和 `/api/asr`（在线画布）共用同一个
 *   `buildRecognizerConfig()` + 同一条解码链，「被测 = 在用」是字面同一份代码。
 *
 * 三条设计约束（与「嘴」speak.ts 同一套感官协议 #27：加官不改协议）：
 *   1. 听是增益 —— 任何失败只降级成 ok:false，绝不抛错、绝不阻塞主链路
 *   2. 只加载一次 —— 实测 createAsync 1234ms / RSS +303MiB，且 OfflineRecognizer
 *      原型没有 free/destroy，**起进程才能回收**。所以宁可回 skipped:'loading'
 *      也不重载，更不做「卸载模型」按钮（那是兑现不了的 UI）
 *   3. 必须用 createAsync / decodeAsync —— 同步构造实测把事件循环冻死
 *      （20ms ticker 计数 0），会连带卡住同进程的 /api/interpret 与静态资源
 *
 * 两条依赖纪律（破坏任一条，上面的等价性就塌回「两份实现碰巧一样」）：
 *   - 顶层不得有副作用：不 require、不读模型、不建 recognizer
 *   - 不得 import settings.ts：方向只能是 index.ts → { settings, asr }，否则成环
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..') // → app/
const MODEL_DIR = join(ROOT, 'models', 'asr', 'sensevoice')
export const MODEL_PATH = join(MODEL_DIR, 'model.int8.onnx')
export const TOKENS_PATH = join(MODEL_DIR, 'tokens.txt')

/** 一句最长听这么久 —— 再长就不该走语音输入了 */
const MAX_SECONDS = 15
/** 等模型加载的兜底上限：超了就回 loading，让前端把这一句当「稍后再试」 */
const WAIT_MS = 8_000
/** 并发闸：防的不是 native 锁，是「同时加载出两个 recognizer = 双倍 300MiB」 */
const MAX_INFLIGHT = 2

export type AsrState = 'unloaded' | 'loading' | 'ready' | 'failed'

export interface AsrResult {
  ok: boolean
  /** 识别文本（已 trim；失败时为 ''） */
  text: string
  /**
   * 降级原因：empty / bad_wav / too_long / unsupported / model_missing /
   * engine_unavailable / loading / busy / decode_failed
   */
  reason?: string
  /** model_missing 时给的操作指引 */
  hint?: string
  ms: number
  decodeMs?: number
  /** 语音时长（毫秒），用来算 RTF = decodeMs / audioMs */
  audioMs?: number
  engine: 'local-sensevoice'
  /** SenseVoice 附带字段：只回传观测，不参与任何判定 */
  lang?: string
  emotion?: string
}

export interface AsrStatus {
  supported: boolean
  modelReady: boolean
  state: AsrState
  loadMs?: number
  rssMiB?: number
  lastError?: string
}

interface WaveLike {
  samples: Float32Array
  sampleRate: number
}

const MODEL_HINT = [
  '缺 SenseVoice 权重：',
  `  1. 下载：见 app/models/OFFLINE_BUNDLE.md（${MODEL_PATH}）`,
  '  2. 运行时：npm i（含 sherpa-onnx-node）',
  '  3. 词表：' + TOKENS_PATH,
  '  4. 装好后设置面板点一次「自检」，或把引擎切回浏览器',
].join('\n')

/**
 * 日志一律走 stderr，不用 console.log。
 * 因为 `asr-transcribe.ts` 的 stdout 就是评测的识别结果（asr-cer 把 stdout 整段当文本），
 * 掺一行 [asr] ok ms= 就会污染 CER 计算。
 */
function log(msg: string): void {
  process.stderr.write(`[asr] ${msg}\n`)
}

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? '')
  return m.split('\n')[0].trim().slice(0, 200)
}

function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1048576)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
  })
}

/**
 * 本机只验过 win32/x64（32 位 node 装得上 ia32 平台包但跑不动 228MB）。
 * 其他平台不是「不行」，是「没证据」——所以先挡住，等有人实测再放开。
 */
export function isAsrSupported(): boolean {
  return process.platform === 'win32' && process.arch === 'x64'
}

export function hasAsrModel(): boolean {
  return existsSync(MODEL_PATH) && existsSync(TOKENS_PATH)
}

/**
 * 唯一的配置真源：离线评测与在线服务都从这里取，改这里就是同时改两边。
 * 与 `asr-transcribe.ts` 原构造逐字段一致（numThreads 4 / CPU / 不传 hotwords）。
 */
export function buildRecognizerConfig(model: string = MODEL_PATH, tokens: string = TOKENS_PATH) {
  return {
    modelConfig: {
      senseVoice: {
        model,
        language: 'zh',
        // ITN 关：开了对「A-100 → a 杠一百」这类读法毫无帮助，只会把中文数字换成
        // 阿拉伯数字，反而打乱评测的逐字对齐（理由同 asr-transcribe.ts:13-14）
        useInverseTextNormalization: 0,
      },
      tokens,
      numThreads: 4,
      debug: 0,
      // 没有 hotwords：SenseVoice 不支持（只有 transducer + modified_beam_search 吃）。
      // models/asr/hotwords.txt 目前只当「ASR 文本规整」工单的词典原料，别往这儿接。
    },
  }
}

// ---------------------------------------------------------------- 运行时状态

let state: AsrState = 'unloaded'
let recognizer: any = null
let loading: Promise<void> | null = null
let lastError: string | undefined
let loadMs: number | undefined
let inflight = 0

interface SherpaBundle {
  mod: any
  /** 主入口没导出 readWaveFromBinary，只能从 addon 子路径拿；null 时走 parsePcmWav 兜底 */
  readBinary: ((data: Uint8Array) => WaveLike) | null
}

let sherpa: SherpaBundle | null | undefined

function loadSherpa(): SherpaBundle | null {
  if (sherpa !== undefined) return sherpa
  try {
    const mod = require_('sherpa-onnx-node')
    let readBinary = mod?.readWaveFromBinary
    if (typeof readBinary !== 'function') {
      // 实测 1.13.7：主入口只 export readWave/writeWave（sherpa-onnx.js:29-30），
      // readWaveFromBinary 只在 addon 层。包没有 exports 字段，所以这个子路径合法。
      // 升级 sherpa-onnx-node 时重新确认这一行。
      readBinary = require_('sherpa-onnx-node/addon.js')?.readWaveFromBinary
    }
    sherpa = { mod, readBinary: typeof readBinary === 'function' ? readBinary : null }
    if (!sherpa.readBinary) log('readWaveFromBinary 不可用，改用内置 PCM WAV 解析')
  } catch (e) {
    log(`sherpa-onnx-node 不可用：${firstLine(e)}`)
    sherpa = null
  }
  return sherpa
}

/**
 * 兜底解码：只认 16-bit PCM（浏览器 encodeWav 产出的就是 canonical 44 字节头）。
 * 存在的唯一理由：readWaveFromBinary 走的是包内部子路径，万一改名不至于全瞎。
 */
function parsePcmWav(bytes: Uint8Array): WaveLike | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 44 || dv.getUint32(0, false) !== 0x52494646) return null // 'RIFF'
  let rate = 0
  let channels = 0
  let bits = 0
  let dataAt = -1
  let dataLen = 0
  for (let p = 12; p + 8 <= bytes.byteLength; ) {
    const id = dv.getUint32(p, false)
    const size = dv.getUint32(p + 4, true)
    if (id === 0x666d7420) {
      // 'fmt '
      channels = dv.getUint16(p + 10, true)
      rate = dv.getUint32(p + 12, true)
      bits = dv.getUint16(p + 22, true)
    } else if (id === 0x64617461) {
      // 'data'
      dataAt = p + 8
      dataLen = Math.min(size, bytes.byteLength - dataAt)
      break
    }
    p += 8 + size + (size % 2)
  }
  if (dataAt < 0 || !rate || !channels || bits !== 16) return null
  const frameCount = Math.floor(dataLen / (2 * channels))
  const samples = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    samples[i] = dv.getInt16(dataAt + i * 2 * channels, true) / 32768
  }
  return { samples, sampleRate: rate }
}

async function doLoad(): Promise<void> {
  if (!isAsrSupported()) {
    state = 'failed'
    lastError = 'unsupported'
    return
  }
  if (!hasAsrModel()) {
    state = 'failed'
    lastError = 'model_missing'
    log(`缺权重：${MODEL_PATH}`)
    return
  }
  const bundle = loadSherpa()
  if (!bundle) {
    state = 'failed'
    lastError = 'engine_unavailable'
    return
  }
  state = 'loading'
  const started = Date.now()
  const rss0 = rssMiB()
  try {
    recognizer = await bundle.mod.OfflineRecognizer.createAsync(buildRecognizerConfig())
    loadMs = Date.now() - started
    state = 'ready'
    lastError = undefined
    log(`LOAD ms=${loadMs} rss=${rss0}->${rssMiB()}MiB（加载后不可回收：native 无释放接口）`)
  } catch (e) {
    recognizer = null
    state = 'failed'
    lastError = firstLine(e)
    log(`加载失败：${lastError}`)
  }
}

/** single-flight。failed 不自动重试（会反复 throw 刷屏），只有 warmAsr 能重来 */
async function ensureReady(): Promise<void> {
  if (state === 'ready' || state === 'failed') return
  if (loading) return loading
  loading = doLoad().finally(() => {
    loading = null
  })
  return loading
}

/** 预热 / 重试。幂等、绝不抛 —— 设置面板的「自检」按钮也打这个 */
export async function warmAsr(): Promise<AsrStatus> {
  if (state === 'failed') state = 'unloaded' // 允许「装好权重后点一下就好」
  try {
    await ensureReady()
  } catch (e) {
    state = 'failed'
    lastError = firstLine(e)
  }
  return asrStatus()
}

/** 纯同步、零副作用（除两次 existsSync），只读模块状态 */
export function asrStatus(): AsrStatus {
  return {
    supported: isAsrSupported(),
    modelReady: hasAsrModel(),
    state,
    loadMs,
    rssMiB: state === 'ready' ? rssMiB() : undefined,
    lastError,
  }
}

/**
 * 读 `state` 必须过这个函数。
 * `state` 是模块级 let，被 `if (state !== 'ready')` 窄化之后，TS **不会因为 await 就让窄化失效**，
 * 于是等待后再直读会被当成 `'unloaded'|'loading'|'failed'`，比 'ready' 直接报 TS2367「永不成立」。
 * 过一层显式返回 AsrState 的函数，类型才打回完整枚举。
 */
function asrStateNow(): AsrState {
  return state
}

// ---------------------------------------------------------------- 识别

export async function transcribeFromWav(
  wav: Uint8Array,
  opts?: { maxSeconds?: number }
): Promise<AsrResult> {
  const started = Date.now()
  const maxSeconds = opts?.maxSeconds ?? MAX_SECONDS

  const fail = (reason: string, extra?: Partial<AsrResult>): AsrResult => {
    const r: AsrResult = { ok: false, text: '', reason, ms: Date.now() - started, engine: 'local-sensevoice', ...extra }
    log(`${reason} ms=${r.ms}`)
    return r
  }

  if (!wav || wav.byteLength === 0) return fail('empty')
  if (!isAsrSupported()) return fail('unsupported')
  if (!hasAsrModel()) return fail('model_missing', { hint: MODEL_HINT })
  if (wav.byteLength < 44) return fail('bad_wav')

  if (asrStateNow() !== 'ready') {
    await Promise.race([ensureReady(), sleep(WAIT_MS)])
    const s = asrStateNow()
    if (s !== 'ready') {
      return s === 'failed'
        ? fail('engine_unavailable', { hint: lastError === 'model_missing' ? MODEL_HINT : undefined })
        : fail('loading')
    }
  }
  if (inflight >= MAX_INFLIGHT) return fail('busy')

  inflight++
  try {
    const bundle = loadSherpa()
    const wave =
      (bundle?.readBinary
        ? safeRead(() => bundle.readBinary!(new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength)))
        : null) ?? parsePcmWav(wav)
    if (!wave || !wave.samples?.length) return fail('bad_wav')

    const audioMs = Math.round((wave.samples.length / wave.sampleRate) * 1000)
    if (audioMs > maxSeconds * 1000) {
      return fail('too_long', { audioMs, reason: `too_long（${(audioMs / 1000).toFixed(1)}s > ${maxSeconds}s）` })
    }

    const d0 = Date.now()
    // 每请求新建 stream：复用会把上一句音频累加进来，症状是「第二句混着第一句的字」
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
    await recognizer.decodeAsync(stream)
    const r = recognizer.getResult(stream)
    const decodeMs = Date.now() - d0
    const text = String(r?.text ?? '').trim()
    const ms = Date.now() - started
    log(
      `ok ms=${ms} decodeMs=${decodeMs} audioMs=${audioMs} rtf=${decodeMs ? (decodeMs / audioMs).toFixed(3) : '?'} rss=${rssMiB()}MiB${text ? '' : ' (空)'}`
    )
    return {
      ok: true,
      text,
      ms,
      decodeMs,
      audioMs,
      engine: 'local-sensevoice',
      lang: stripTag(r?.lang),
      emotion: stripTag(r?.emotion),
    }
  } catch (e) {
    log(`decode_failed：${firstLine(e)}`)
    return fail('decode_failed')
  } finally {
    inflight--
  }
}

/** SenseVoice 的 lang/emotion 回的是 `<|zh|>` `<|NEUTRAL|>` 这种原始标签，剥掉包裹 */
function stripTag(v: unknown): string | undefined {
  const s = String(v ?? '').replace(/^<\|/g, '').replace(/\|>$/g, '').trim()
  return s || undefined
}

function safeRead<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (e) {
    log(`readWaveFromBinary 抛错，回落内置解析：${firstLine(e)}`)
    return null
  }
}

/** 给离线评测 / 脚本用：读一个 wav 文件路径 */
export async function transcribeWavFile(path: string): Promise<AsrResult> {
  if (!existsSync(path)) return { ok: false, text: '', reason: 'empty', ms: 0, engine: 'local-sensevoice' }
  return transcribeFromWav(new Uint8Array(readFileSync(path)))
}
