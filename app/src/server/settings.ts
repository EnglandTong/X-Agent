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

export interface LlmSettings {
  /** rules = 规则引擎（离线可跑）；openai = OpenAI 兼容接口（火山方舟 / DeepSeek / 本地 Ollama 都走这个） */
  provider: Provider
  /** OpenAI 兼容根地址，末尾不要带 /chat/completions */
  baseUrl: string
  apiKey: string
  model: string
  /** 超时（毫秒）—— 手机网络下别设太短 */
  timeoutMs: number
}

export const DEFAULT_SETTINGS: LlmSettings = {
  provider: 'rules',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  model: 'doubao-seed-2.0-mini',
  timeoutMs: 20000,
}

/** 火山方舟常用模型（下拉快捷选项，也可手填任意模型名 / ep-xxx 接入点） */
export const MODEL_PRESETS = [
  'doubao-seed-2.0-mini',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-code',
  'glm-5',
  'kimi-k2.7-code',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]

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
}

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
    presets: MODEL_PRESETS,
  }
}
