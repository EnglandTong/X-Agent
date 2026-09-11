/**
 * 运行期配置 —— 模型连接参数
 *
 * 为什么是「设置面板填 key」而不是写死在代码里：
 *   1. key 不进对话记录、不进 git（.env.local 已在 .gitignore）
 *   2. 手机上也能改 —— 服务在云上跑，改完立即生效，不用重新部署
 *   3. 换模型 / 换供应商只是一次表单提交，PoC 阶段要的就是这个速度
 *
 * 存储：app/.env.local（KEY=VALUE）。
 * 优先级：process.env > .env.local > 内置默认。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const ENV_LOCAL = join(ROOT, '.env.local')

export type Provider = 'rules' | 'openai'

/** 语音识别用哪只耳朵：browser = 浏览器 Web Speech（在线、零重量）；local = 本地 SenseVoice（离线、常驻约 303MiB） */
export type AsrEngine = 'browser' | 'local'

export interface LlmSettings {
  /** rules = 规则引擎（离线可跑）；openai = OpenAI 兼容接口（火山方舟 / DeepSeek / 本地 Ollama 都走这个） */
  provider: Provider
  /** OpenAI 兼容根地址，末尾不要带 /chat/completions */
  baseUrl: string
  apiKey: string
  model: string
  /** 超时（毫秒）—— 手机网络下别设太短 */
  timeoutMs: number
  /** 语音播报（「嘴」，Windows SAPI）—— 不属于 LLM，但共用同一个 .env.local 与设置面板 */
  ttsEnabled: boolean
  /**
   * 语音识别（「耳」）—— 与「嘴」并列的第二个感官开关。
   * 两只耳朵并存是刻意的：本地那只才是被测过 CER 的，浏览器那只是 fallback。
   */
  asrEngine: AsrEngine
}

export const DEFAULT_SETTINGS: LlmSettings = {
  /** 无 Key 时回落 rules；有云端/本地 Key 时应切 openai（产品默认：LLM 优先） */
  provider: 'rules',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  model: 'doubao-seed-2.0-mini',
  timeoutMs: 20000,
  /** 默认开：接进画布就是为了让它主动说话（可在设置面板一键关） */
  ttsEnabled: true,
  /**
   * 默认浏览器：零行为变更，且没下 228MB 权重的人完全无感。
   * 这一档同时就是最小回退 —— 出问题切回 browser，不用重启也不用重编。
   */
  asrEngine: 'browser',
}

/** 快捷模型名（云端 + 本地断网目标） */
export const MODEL_PRESETS = [
  'doubao-seed-2.0-mini',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-code',
  'glm-5',
  'kimi-k2.7-code',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  /** 远期可选本地大脑（Ollama）；现阶不要求本机运行 */
  'qwen3:0.6b',
  'qwen3:1.7b',
]

/** 本地 Qwen3-0.6B 快捷项（可选·暂缓；默认仍用云端） */
export const LOCAL_QWEN06_PRESET: Partial<LlmSettings> = {
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama',
  model: 'qwen3:0.6b',
  timeoutMs: 60000,
}

// ---------------------------------------------------------------- 解析 .env.local

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    // 去掉配对的引号
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function readEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL)) return {}
  try {
    return parseEnv(readFileSync(ENV_LOCAL, 'utf-8'))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------- 读 / 写

const KEY_MAP: Record<keyof LlmSettings, string> = {
  provider: 'LLM_PROVIDER',
  baseUrl: 'LLM_BASE_URL',
  apiKey: 'LLM_API_KEY',
  model: 'LLM_MODEL',
  timeoutMs: 'LLM_TIMEOUT_MS',
  ttsEnabled: 'TTS_ENABLED',
  asrEngine: 'ASR_ENGINE',
}

/** TTS_ENABLED 的假值写法（大小写不敏感）；空 = 用默认值（开）。只服务布尔项，字符串枚举走白名单 */
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no'])

export function loadSettings(): LlmSettings {
  const file = readEnvLocal()
  const get = (k: string) => process.env[k] ?? file[k]

  const provider = (get(KEY_MAP.provider) ?? '').toLowerCase()
  const timeout = Number(get(KEY_MAP.timeoutMs))

  return {
    provider: provider === 'openai' ? 'openai' : 'rules',
    baseUrl: get(KEY_MAP.baseUrl) || DEFAULT_SETTINGS.baseUrl,
    apiKey: get(KEY_MAP.apiKey) || '',
    model: get(KEY_MAP.model) || DEFAULT_SETTINGS.model,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_SETTINGS.timeoutMs,
    ttsEnabled: !FALSE_WORDS.has((get(KEY_MAP.ttsEnabled) ?? '').trim().toLowerCase()),
    // 白名单回落（同 provider）：只有显式 local 才是 local，写错值 / 空值都等于 browser
    asrEngine: (get(KEY_MAP.asrEngine) ?? '').trim().toLowerCase() === 'local' ? 'local' : 'browser',
  }
}

/** 写回 .env.local：只改这几个 key，其他内容原样保留 */
export function saveSettings(next: LlmSettings): LlmSettings {
  const file = readEnvLocal()
  file[KEY_MAP.provider] = next.provider
  file[KEY_MAP.baseUrl] = next.baseUrl
  file[KEY_MAP.apiKey] = next.apiKey
  file[KEY_MAP.model] = next.model
  file[KEY_MAP.timeoutMs] = String(next.timeoutMs)
  file[KEY_MAP.ttsEnabled] = next.ttsEnabled ? '1' : '0'
  file[KEY_MAP.asrEngine] = next.asrEngine

  const body = Object.entries(file)
    .map(([k, v]) => `${k}=${/\s|#|"/.test(v) ? JSON.stringify(v) : v}`)
    .join('\n')
  writeFileSync(ENV_LOCAL, `# AGT-ERP 本地配置（由设置面板写入，不进 git）\n${body}\n`, 'utf-8')

  // 同步到进程环境，免重启生效
  process.env[KEY_MAP.provider] = next.provider
  process.env[KEY_MAP.baseUrl] = next.baseUrl
  process.env[KEY_MAP.apiKey] = next.apiKey
  process.env[KEY_MAP.model] = next.model
  process.env[KEY_MAP.timeoutMs] = String(next.timeoutMs)
  process.env[KEY_MAP.ttsEnabled] = next.ttsEnabled ? '1' : '0'
  process.env[KEY_MAP.asrEngine] = next.asrEngine

  return loadSettings()
}

// ---------------------------------------------------------------- 展示

/** API Key 只回传掩码 —— 前端永远拿不到完整 key */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return `${key.slice(0, 4)}${'*'.repeat(Math.min(12, key.length - 8))}${key.slice(-4)}`
}

export function publicView(s: LlmSettings) {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    timeoutMs: s.timeoutMs,
    apiKey: maskKey(s.apiKey),
    hasKey: !!s.apiKey,
    ttsEnabled: s.ttsEnabled,
    ttsBackend: 'Windows SAPI（服务进程本机出声，0MB）',
    asrEngine: s.asrEngine,
    presets: MODEL_PRESETS,
    localQwen06: LOCAL_QWEN06_PRESET,
    enginePriority: 'cloud_llm > rules（ASR 本地化；本地 LLM 暂缓）',
  }
}
