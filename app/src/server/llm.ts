/**
 * LLM 客户端 —— OpenAI 兼容接口
 *
 * 火山方舟（ark.cn-beijing.volces.com/api/v3）、DeepSeek、本地 Ollama
 * 都走这一份代码，因为它们都是 OpenAI 兼容协议。换供应商 = 改两个字段。
 *
 * 关键设计：**模型只做「听写」，不做「理解」。**
 *   模型输出的是用户原话里的片段（"张三" / "下周三" / "一百二十"），
 *   不是 ID、不是算好的日期、不是阿拉伯数字。
 *   转换全部交给 resolve.ts 的确定性代码 —— 这样小模型才不会算错，
 *   也才能保证同一句话每次结果一致。
 */

import type { ToolSchema } from './compile'
import type { LlmSettings } from './settings'

/** 主数据词典（结构与 agent.ts 的 ExtractDict 一致，这里重复声明以避免循环依赖） */
export interface ExtractDict {
  customers: Array<{ id: string; name: string; code: string }>
  products: Array<{ id: string; model: string; name: string }>
}

// ---------------------------------------------------------------- 类型

export interface LlmExtraction {
  verb: string
  confidence: number
  /** 槽位名 → 用户原话片段 */
  slots: Record<string, string>
  ms: number
  /** 模型原始输出，进 Trace，出问题时一眼能看出是模型的锅还是解析的锅 */
  raw: string
}

export interface Diagnostics {
  ok: boolean
  ms: number
  baseUrl: string
  model: string
  /** 人类可读的错误 */
  error?: string
  /** 服务端返回的原始片段 —— 排查 401 / 模型名映射错误全靠它 */
  detail?: string
}

// ---------------------------------------------------------------- 底层请求

function endpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  if (b.endsWith('/chat/completions')) return b
  return `${b}/chat/completions`
}

interface ChatArgs {
  settings: LlmSettings
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
  /** 是否强制 JSON 输出（部分模型不支持，失败会自动降级） */
  jsonMode: boolean
}

async function chat(args: ChatArgs): Promise<{ text: string; ms: number }> {
  const { settings, messages, maxTokens, jsonMode } = args
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), settings.timeoutMs)
  const t0 = Date.now()

  try {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
    }
    if (jsonMode) body.response_format = { type: 'json_object' }

    const res = await fetch(endpoint(settings.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })

    const text = await res.text()
    const ms = Date.now() - t0

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & {
        status?: number
        detail?: string
      }
      err.status = res.status
      err.detail = text.slice(0, 800)
      throw err
    }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      const err = new Error('响应不是合法 JSON') as Error & { detail?: string }
      err.detail = text.slice(0, 800)
      throw err
    }

    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      const err = new Error('响应里没有 choices[0].message.content') as Error & {
        detail?: string
      }
      err.detail = text.slice(0, 800)
      throw err
    }
    // 部分模型（含 reasoning 类）把思考过程放在 reasoning_content，正文才是 content
    return { text: content, ms }
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型输出里抠出第一个 JSON 对象 —— 兼容模型在 JSON 前后啰嗦的情况 */
function extractJson(text: string): any {
  const t = text.trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('输出里找不到 JSON 对象')
  return JSON.parse(t.slice(start, end + 1))
}

// ---------------------------------------------------------------- 连通性测试

export async function ping(settings: LlmSettings): Promise<Diagnostics> {
  const base = {
    baseUrl: settings.baseUrl,
    model: settings.model,
    ms: 0,
  }

  if (settings.provider !== 'openai') {
    return { ...base, ok: true, error: '当前是规则引擎模式，未连接模型' }
  }
  if (!settings.apiKey) {
    return { ...base, ok: false, error: '还没填 API Key' }
  }

  try {
    const { ms } = await chat({
      settings,
      messages: [
        { role: 'system', content: 'You are a connectivity probe.' },
        { role: 'user', content: '回复 OK 两个字母，不要其它内容。' },
      ],
      maxTokens: 16,
      jsonMode: false,
    })
    return { ...base, ok: true, ms }
  } catch (e: any) {
    const status = e?.status
    const detail = e?.detail ?? String(e?.message ?? e)
    return {
      ...base,
      ok: false,
      error: status ? `HTTP ${status}${status === 401 ? ' · 鉴权失败（key 无效 / 无该模型权限 / endpoint 不匹配）' : ''}` : String(e?.message ?? e),
      detail,
    }
  }
}

// ---------------------------------------------------------------- 提示词

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function buildSystemPrompt(
  tools: Map<string, ToolSchema>,
  schemas: Map<string, any>,
  dict: ExtractDict,
  today: Date
): string {
  const verbLines: string[] = []
  for (const [name, tool] of tools) {
    const schema = schemas.get(name)
    const slots = Object.entries<any>(tool.parameters.properties).map(([slot, p]) => {
      const ex = p['x-examples']?.length ? ` 例：${p['x-examples'].slice(0, 3).join(' / ')}` : ''
      return `${slot}(${p.description ?? slot})${ex}`
    })
    verbLines.push(
      `- ${name}｜${schema?.title ?? tool.description}｜槽位：${slots.join('；')}`
    )
  }

  // 枚举提示：告诉模型合法取值，但也允许它原样输出用户说法（交给消解器兜底）
  const enumHints: string[] = []
  for (const [name, tool] of tools) {
    for (const [slot, p] of Object.entries<any>(tool.parameters.properties)) {
      if (p.enum?.length) enumHints.push(`- ${name}.${slot} 合法值：${p.enum.join(' / ')}`)
    }
  }

  const cust = dict.customers.slice(0, 60).map((c) => c.name).join('、')
  const prod = dict.products.slice(0, 60).map((p) => `${p.model}(${p.name})`).join('、')

  return `你是 ERP 系统的语义解析器。用户用中文口语说一句话，你要做两件事：判断他要执行哪个「动词」，把话里提到的信息原样抽出来。

铁律：
1. 只输出一个 JSON 对象。不要解释，不要用 markdown 代码块包起来。
2. slots 的值必须是用户原话里的片段，禁止做任何转换：
   - 客户名不要换成编码或 ID（写"张三"，不要写 C001）
   - 日期不要计算（写"下周三"，不要写 2026-09-16）
   - 数量保持原样（写"一百二十"，不要写 120）
   - 产品别称不要改写成型号（写"那个A型"，不要写 A-100）
3. 用户没提到的槽位就省略，绝不编造、绝不猜测、绝不用"同上"之类占位。
4. verb 必须是下面清单里的一个，不能自创。判断不了就选最像的那个。
5. 若用户是在「改一张已经存在的单」，verb 仍是 order.create，并把原单号抽到 origin_no。

动词清单：
${verbLines.join('\n')}

${enumHints.length ? `取值提示（用户说法不在列表内时，按原话输出即可，系统会做匹配）：\n${enumHints.join('\n')}\n` : ''}
主数据参考（用于消歧，用户说法可能不完整或带口音）：
客户：${cust || '（无）'}
产品：${prod || '（无）'}

今天是 ${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} ${WEEK[today.getDay()]}。

输出格式（缺槽位就省略该 key）：
{"verb":"order.create","slots":{"customer":"张三","product":"A-100","quantity":"120","delivery_date":"下周三"},"confidence":0.92}`
}

// ---------------------------------------------------------------- 抽取

export interface ExtractOptions {
  settings: LlmSettings
  tools: Map<string, ToolSchema>
  schemas: Map<string, any>
  dict: ExtractDict
  today: Date
}

export async function llmExtract(
  utterance: string,
  opts: ExtractOptions
): Promise<LlmExtraction> {
  const { settings, tools, schemas, dict, today } = opts
  const system = buildSystemPrompt(tools, schemas, dict, today)

  // 先试 JSON 模式；模型不支持时（400）降级为普通模式 + 正则抠 JSON
  let text = ''
  let ms = 0
  try {
    const r = await chat({
      settings,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `用户原话："""${utterance}"""` },
      ],
      maxTokens: 400,
      jsonMode: true,
    })
    text = r.text
    ms = r.ms
  } catch (e: any) {
    if (e?.status !== 400) throw e
    const r = await chat({
      settings,
      messages: [
        { role: 'system', content: `${system}\n\n（注意：本模型未开启 JSON 模式，请确保输出是纯 JSON。）` },
        { role: 'user', content: `用户原话："""${utterance}"""` },
      ],
      maxTokens: 400,
      jsonMode: false,
    })
    text = r.text
    ms = r.ms
  }

  const json = extractJson(text)

  const verb = String(json.verb ?? '').trim()
  if (!tools.has(verb)) {
    throw new Error(`模型给出了不存在的动词：${verb || '（空）'}`)
  }

  const allowed = new Set(Object.keys(tools.get(verb)!.parameters.properties))
  const slots: Record<string, string> = {}
  for (const [k, v] of Object.entries<any>(json.slots ?? {})) {
    if (!allowed.has(k)) continue // 模型臆造的槽位直接丢弃
    if (v === null || v === undefined || v === '') continue
    slots[k] = typeof v === 'string' ? v.trim() : String(v)
  }

  const c = Number(json.confidence)
  return {
    verb,
    slots,
    confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.8,
    ms,
    raw: text.slice(0, 2000),
  }
}
