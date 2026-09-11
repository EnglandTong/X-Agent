/**
 * 「嘴」—— TTS 播报（Windows SAPI，0MB 零依赖）
 *
 * 为什么把 npm run say 抽成模块：
 *   画布要在「执行完动词」「还有字段没问到」这两个时刻主动出声，
 *   声音必须由服务进程发，不能 cada 前端各喊各的（并发会叠音）。
 *
 * 三条设计约束（参照感官协议 #27：加官不改协议）：
 *   1. 播报是增益 —— 失败只降级（打印文本），绝不抛错、绝不阻塞主链路
 *   2. 排队串行 —— SAPI 一次只能读一句，并发 spawn 会互相盖住
 *   3. 非 Windows / 缺 SAPI → 打印文本并正常返回（嘴缺位不能影响业务）
 */

import { spawn } from 'node:child_process'

export interface SpeakResult {
  ok: boolean
  /** 降级原因：empty / unsupported / sapi_unavailable / timeout */
  reason?: string
  ms: number
}

/** 一次最多念这么长 —— 超长文本没人听，也拖慢队列 */
const MAX_CHARS = 300
/** 单个进程的兜底超时：PowerShell 卡住时不能把队列堵死 */
const TIMEOUT_MS = 30_000

export function isTtsSupported(): boolean {
  return process.platform === 'win32'
}

/**
 * 文本以 PowerShell 单引号字面量拼进命令串。
 *
 * 两个坑（都是本机实测踩出来的，别改回去）：
 *   1. **不能用 -EncodedCommand** —— 本机环境对它直接 EPERM（常见 AV / 策略拦截点），
 *      而 -Command 正常。表现是 spawn 抛 EPERM，且只在真正的播报参数上出现。
 *   2. **不能用 -Command + 位置参数** —— Windows PowerShell 5.1 会把多余参数
 *      原样拼到命令串末尾（`… $s.Speak($args[0]) 中文测试` → ParserError）。
 *      所以文本只能内联进命令串，并用单引号包住（单引号串里只有 ' 需要写成 ''）。
 *
 * 另外显式挑 zh-* 语音：默认语音可能是 en-US，中文会被念成奇怪的音。
 */
/** PowerShell 单引号字面量：串里只有 ' 需要写成 '' */
function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function buildArgs(text: string): string[] {
  const literal = psLiteral(text)
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -like "zh-*" } | Select-Object -First 1',
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$s.Volume = 100',
    '$s.Rate = 0',
    `$s.Speak(${literal})`,
  ].join('; ')
  return ['-NoProfile', '-Command', script]
}

let queue: Promise<unknown> = Promise.resolve()

/** 播报一句。返回是否已出声；调用方不必 await（内部已排队） */
export function speak(text: string): Promise<SpeakResult> {
  const started = Date.now()
  const clean = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  if (!clean) return Promise.resolve({ ok: false, reason: 'empty', ms: 0 })

  if (!isTtsSupported()) {
    console.log(`[speak] 非 Windows，跳过播报：${clean}`)
    return Promise.resolve({ ok: false, reason: 'unsupported', ms: 0 })
  }

  const task = queue.then(
    () =>
      new Promise<SpeakResult>((resolve) => {
        let settled = false
        const finish = (r: SpeakResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(r)
        }

        const child = spawn('powershell.exe', buildArgs(clean), {
          stdio: 'ignore',
          windowsHide: true,
        })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* 已经退出，忽略 */
          }
          console.log(`[speak] 播报超时，已跳过：${clean}`)
          finish({ ok: false, reason: 'timeout', ms: Date.now() - started })
        }, TIMEOUT_MS)
        // 兜底定时器不该把进程拖住
        ;(timer as unknown as { unref?: () => void }).unref?.()

        child.on('error', () => {
          console.log(`[speak] SAPI 不可用，文本如下：${clean}`)
          finish({ ok: false, reason: 'sapi_unavailable', ms: Date.now() - started })
        })
        child.on('close', (code) => {
          if (code === 0) {
            finish({ ok: true, ms: Date.now() - started })
          } else {
            console.log(`[speak] SAPI 不可用（status=${code}），文本如下：${clean}`)
            finish({ ok: false, reason: 'sapi_unavailable', ms: Date.now() - started })
          }
        })
      })
  )

  // 队列只用来串行，失败不污染后续任务
  queue = task.catch(() => {})
  return task
}

/**
 * 合成到 wav —— 不发声，只落文件。
 *
 * 用途：给 ASR 评测造音频（`npm run asr:wavs`）。没有真人录音之前，
 * 用系统自己的嘴念一遍，至少能验证「模型装好了没 / 中文能不能识别」。
 * 注意这是**合成语音**，CER 会偏乐观，不能当真实口音结论。
 */
export function synthesizeWav(text: string, outPath: string): Promise<boolean> {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean || !isTtsSupported()) return Promise.resolve(false)

  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -like "zh-*" } | Select-Object -First 1',
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$s.Volume = 100',
    `$s.SetOutputToWaveFile(${psLiteral(outPath)})`,
    `$s.Speak(${psLiteral(clean)})`,
    '$s.Dispose()',
  ].join('; ')

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
