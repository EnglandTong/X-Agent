/**
 * Agent 层 —— 意图识别 + 槽位抽取
 *
 * ┌───────────────────────────────────────────────────────────────┐
 * │  当前实现：RULES（stub）                                       │
 * │  W1 目标：换成 Pi SDK + 本地 1.7B 模型                          │
 * │  接口不变 —— 上层（路由 / UI）零改动                            │
 * └───────────────────────────────────────────────────────────────┘
 *
 * 关键设计：**模型只输出「用户提到了哪些词的原文」，不输出 ID、不做计算。**
 *
 *   用户："给张三来 120 个 A-100，下周三要"
 *                     ↓  模型
 *   { verb: "order.create", slots: {
 *       customer: "张三", product: "A-100",
 *       quantity: "120", delivery_date: "下周三" } }
 *                     ↓  消解器（确定性代码）
 *   { customer: {id:"c1", label:"张三（C001）", confidence:0.98},
 *     product:  {id:"p1", label:"A-100 标准件", confidence:0.98},
 *     quantity: 120, delivery_date: "2026-09-16" }
 *
 * 为什么这么切：
 *   模型不需要背数据库主键（1.7B 背不住）、不需要做日期算术（会算错）、
 *   不需要做中文数字转换。把这些交给代码后，模型只剩「听说读写」里
 *   最擅长的「听」—— 这正是小模型能胜任的原因。
 */

import type { ToolSchema } from './compile'
import { resolveSlot, type ResolveCtx, type Resolved } from './resolve'
import { llmExtract } from './llm'
import { piExtract } from './piAgent'
import type { LlmSettings } from './settings'
import { lookupVerb, phraseNorm } from './lexicon'

// ---------------------------------------------------------------- 类型

export interface SlotResult {
  /** 槽位名（= tool 参数名） */
  slot: string
  /** 表单字段名 */
  field: string
  /** 字段标题，用于 UI 展示 */
  title: string
  /** 用户原话里的原始值 */
  raw: unknown
  /** 消解后的值（写入数据库的值） */
  value: unknown
  /** 展示文本 */
  label?: string
  /** 0-1 */
  confidence: number
  /** 值的来源：user=用户明说 / inferred=系统推断 / missing=缺失 */
  source: 'user' | 'inferred' | 'missing'
  /** 该槽位是否必填 —— 决定 UI 上「缺失」是标红还是标灰 */
  required: boolean
  /** 歧义候选 */
  candidates?: Array<{ id: string; label: string; hint?: string }>
  /** 消解说明，进 Trace 面板 */
  note?: string
}

export interface Interpretation {
  verb: string
  verbTitle: string
  verbConfidence: number
  risk: 'read' | 'write'
  requiresConfirm: boolean
  slots: SlotResult[]
  /** 必填但仍缺失的槽位（schema.required 且无值） */
  missing: string[]
  /** 缺失时的反问文案 —— 一次问完，不逐个追问 */
  question?: string
  /** 是否可以直接执行（只读且无缺失） */
  ready: boolean
  /** 这一格是规则引擎抽的，还是模型抽的 —— 出问题时第一眼要看的字段 */
  engine: 'rules' | 'llm' | 'pi'
  llm?: { ms: number; error?: string; raw?: string }
}

// ---------------------------------------------------------------- 意图识别

const QUERY_SIGNALS = [
  '查', '看看', '看一下', '多少', '几张', '几个', '列表', '有没有',
  '状态', '最近', '什么时候', '哪些', '找一下', '搜',
]
const CREATE_SIGNALS = [
  '下单', '建单', '创建', '新增', '开单', '录一', '来一', '要一',
  '订', '下一单', '做个单', '帮我开', '录个', '来', '要', '订一',
]

function pickAvailable(available: string[], preferred: string[], fallback: string) {
  for (const v of preferred) {
    if (available.includes(v)) return v
  }
  return available.includes(fallback) ? fallback : available[0] ?? fallback
}

function detectVerb(utterance: string, available: string[]): { verb: string; confidence: number } {
  const s = utterance.toLowerCase()

  // --- 专用意图（优先于通用查/建）---
  if (/取消/.test(s) && available.includes('order.cancel')) {
    return { verb: 'order.cancel', confidence: 0.92 }
  }
  if (/(确认出货|出货确认|确认\s*DN|DN[-\s]?\d)/i.test(s) && available.includes('delivery.confirm')) {
    return { verb: 'delivery.confirm', confidence: 0.9 }
  }
  if (/(做出货|开出货|生成出货|出货单)/.test(s) && !/确认出货|查/.test(s) && available.includes('delivery.create')) {
    return { verb: 'delivery.create', confidence: 0.9 }
  }
  if (/(查出货|出货记录|出货单)/.test(s) && /查|看看|列表/.test(s) && available.includes('delivery.query')) {
    return { verb: 'delivery.query', confidence: 0.88 }
  }
  if (/查.{0,8}出货|出货.{0,4}(查|看看)/.test(s) && available.includes('delivery.query')) {
    return { verb: 'delivery.query', confidence: 0.86 }
  }
  if (/(释放.*预留|取消预留|放预留|预留.*释放)/.test(s) && available.includes('inventory.release')) {
    return { verb: 'inventory.release', confidence: 0.9 }
  }
  if (/(预留)/.test(s) && !/释放|取消预留/.test(s) && available.includes('inventory.reserve')) {
    return { verb: 'inventory.reserve', confidence: 0.88 }
  }
  if (/(库存)/.test(s) && available.includes('inventory.query')) {
    return { verb: 'inventory.query', confidence: 0.88 }
  }
  if (/(信用|额度).*(查|看|检查|够不够)|查.*(信用|额度)/.test(s) && available.includes('credit.check')) {
    return { verb: 'credit.check', confidence: 0.9 }
  }
  if (/(客户资料|查客户|客户.*额度|客户信息)/.test(s) && available.includes('customer.query')) {
    return { verb: 'customer.query', confidence: 0.9 }
  }
  if (/查.{0,6}客户|看看.{0,4}额度/.test(s) && available.includes('customer.query')) {
    return { verb: 'customer.query', confidence: 0.86 }
  }
  if (/确认/.test(s) && /(订单|SO|那单|这单|\d{3,5})/i.test(s) && available.includes('order.confirm')) {
    return { verb: 'order.confirm', confidence: 0.9 }
  }
  if (/(变更|改成|开变更|改数量)/.test(s) && available.includes('order.create')) {
    return { verb: 'order.create', confidence: 0.88 }
  }

  const createHit = CREATE_SIGNALS.filter((w) => s.includes(w)).length
  const queryHit = QUERY_SIGNALS.filter((w) => s.includes(w)).length

  const hasQty = /(\d+|[一二两三四五六七八九十百千万]+)\s*(个|只|件|台|套|箱|支|条|pcs|PCS)/.test(s)
  const hasModel = /[A-Za-z]\s*-?\s*\d{3}/.test(s)

  if (createHit > 0 && queryHit === 0) {
    return { verb: pickAvailable(available, ['order.create'], 'order.create'), confidence: 0.9 }
  }
  if (queryHit > 0 && createHit === 0) {
    return { verb: pickAvailable(available, ['order.query'], 'order.query'), confidence: 0.9 }
  }
  if (createHit > 0 && queryHit > 0) {
    return hasQty
      ? { verb: pickAvailable(available, ['order.create'], 'order.create'), confidence: 0.65 }
      : { verb: pickAvailable(available, ['order.query'], 'order.query'), confidence: 0.65 }
  }
  if (hasModel && hasQty) {
    return { verb: pickAvailable(available, ['order.create'], 'order.create'), confidence: 0.72 }
  }
  // 「客户…产品…数量…」表格式口吻，即使没有「来/要」也当建单
  if (
    (/客户/.test(s) || dictishCustomer(s)) &&
    (hasModel || /产品/.test(s)) &&
    (/数量|交期/.test(s) || hasQty || /[零一二两三四五六七八九十百千]+\s*$/.test(s) || /数量\s*[零一二三四五六七八九十百千万\d]+/.test(s))
  ) {
    return { verb: pickAvailable(available, ['order.create'], 'order.create'), confidence: 0.7 }
  }
  if (hasModel || /订单/.test(s)) {
    return { verb: pickAvailable(available, ['order.query'], 'order.query'), confidence: 0.55 }
  }

  return { verb: available[0] ?? 'order.query', confidence: 0.3 }
}

function dictishCustomer(s: string) {
  return /张三|张伟|李四|王五|C00\d/.test(s)
}

// ---------------------------------------------------------------- 槽位抽取（规则版）

export interface ExtractDict {
  customers: Array<{ id: string; name: string; code: string }>
  products: Array<{ id: string; model: string; name: string }>
}

/**
 * 把口语里的中文数字换成阿拉伯数字，只用于型号识别。
 * "A一百" → "A100"，这样一条正则就能覆盖口语变体。
 */
function digitsToArabic(s: string): string {
  const cn: Array<[string, string]> = [
    ['零', '0'], ['一', '1'], ['二', '2'], ['两', '2'], ['三', '3'],
    ['四', '4'], ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9'],
  ]
  let out = s
  for (const [c, d] of cn) out = out.split(c).join(d)
  // "A十" 这类不做处理，型号里几乎没有
  return out
}

/**
 * 抽数量之前，先把「型号 / 编码 / 单号」里的数字遮掉（**等长替换，保证索引不变**）。
 *
 * 不做这一步的后果（真实错例，来自 eval）：
 *   「A-100一百个」        → 抽出 **1**（型号里的 1）
 *   「SO-2026-1002改成150个」→ 抽出 **6**（单号里的 6）
 *   数量错了人一眼看不出来 —— 这是会静默落错数据的缺陷。
 */
function maskCodes(text: string): string {
  return text
    .replace(/[A-Za-z]{1,6}\s*-?\s*\d{2,}/g, (s) => '▮'.repeat(s.length))
    .replace(/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/g, (s) => '▮'.repeat(s.length))
}

/**
 * 从话术抽出多行「型号 + 数量」。
 * 例：「100个A-100和200个B-200」「A-100×50，B-200 30个」
 */
function extractOrderLines(
  utterance: string,
  dict: ExtractDict
): Array<{ product: string; quantity: string }> {
  const text = digitsToArabic(utterance)
  // 数量专用文本：型号/单号/编码里的数字不参与数量匹配
  const qtyText = maskCodes(text)
  const models: Array<{ model: string; index: number; end: number }> = []
  const modelRe = /([A-Za-z])\s*-?\s*(\d{3})/g
  let m: RegExpExecArray | null
  while ((m = modelRe.exec(text)) !== null) {
    models.push({
      model: `${m[1].toUpperCase()}-${m[2]}`,
      index: m.index,
      end: m.index + m[0].length,
    })
  }
  // 词典名兜底：若无型号字面量但提到产品名，最多一行
  if (!models.length) {
    const hit = dict.products
      .filter((p) => p.name.length >= 2 && utterance.includes(p.name))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!hit) return []
    const qtyMatch = qtyText.match(
      /(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(?:个|只|件|台|套|箱|支|条)/
    )
    return qtyMatch ? [{ product: hit.model, quantity: qtyMatch[1] }] : []
  }

  const lines: Array<{ product: string; quantity: string }> = []
  for (let i = 0; i < models.length; i++) {
    const cur = models[i]
    const prevEnd = i === 0 ? 0 : models[i - 1].end
    const nextStart = i + 1 < models.length ? models[i + 1].index : text.length
    const before = qtyText.slice(prevEnd, cur.index)
    const after = qtyText.slice(cur.end, nextStart)
    const qtyBefore = before.match(
      /(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(?:个|只|件|台|套|箱|支|条)?\s*$/
    )
    const qtyAfter = after.match(
      /^\s*[×x*＋+]?\s*(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(?:个|只|件|台|套|箱|支|条)?/
    )
    const qty = qtyBefore?.[1] ?? qtyAfter?.[1]
    if (qty) lines.push({ product: cur.model, quantity: qty })
  }
  return lines
}

/** 冒烟 / 评测用：暴露多行抽取 */
export function extractOrderLinesForTest(
  utterance: string,
  dict: ExtractDict
): Array<{ product: string; quantity: string }> {
  return extractOrderLines(utterance, dict)
}

/**
 * 规则抽取器。
 * 这是 stub —— 它的输出格式就是未来 LLM 的输出格式。
 * 换成真实模型时，只需要替换这一个函数，其余全部不动。
 *
 * 刻意引入 entityDict：真实系统里，模型抽完之后同样要用主数据词典做一遍
 * 校正（把"张总"对齐到"张三"、把"那个A型"对齐到"A-100"）。
 * 这一步不是 hack，是生产系统必做的实体链接（Entity Linking）。
 */
function extractSlotsRules(
  utterance: string,
  dict: ExtractDict
): Record<string, string> {
  const slots: Record<string, string> = {}

  // ---------- 记住句式（lexicon.remember，D10）----------
  // 命中即独占抽取，避免「记住老李就是李四」被抽成 customer=李四 之类污染
  if (/记住|记一下|帮我记|记着/.test(utterance)) {
    const m = utterance.match(
      /(?:记住|记一下|帮我记|记着)[：:,，]?\s*(.{1,12}?)\s*(?:就是|就系|＝|等于|是)\s*(.{1,24})$/
    )
    if (m) {
      slots.phrase = m[1].trim()
      slots.target_text = m[2].trim()
      return slots
    }
  }

  // ---------- 客户 ----------
  // 1) 显式前缀："给张三…" / "客户是上海XX"
  const custMatch = utterance.match(
    /(?:客户是|客户[：:]|给|为)\s*([^\s，,。、]{1,8}?)(?=[来下要订做开录\s，,。、]|$)/
  )
  if (custMatch && !/^\d+$/.test(custMatch[1])) {
    slots.customer = custMatch[1]
  } else {
    // 2) 词典包含：句子里直接出现了某个已知客户名或编码
    //    按名字长度降序，避免"张伟"被"张"抢先（虽然两者都会命中，取更具体的）
    const hit = dict.customers
      .filter((c) => utterance.includes(c.name) || utterance.toUpperCase().includes(c.code))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (hit) slots.customer = hit.name
  }

  // ---------- 产品（可多行）----------
  const lineItems = extractOrderLines(utterance, dict)
  if (lineItems.length >= 2) {
    slots.items = JSON.stringify(lineItems)
    slots.product = lineItems[0].product
    slots.quantity = lineItems[0].quantity
  } else if (lineItems.length === 1) {
    slots.product = lineItems[0].product
    slots.quantity = lineItems[0].quantity
  } else {
    const modelRegex = /([A-Za-z])\s*-?\s*(\d{3})/
    const prodMatch = utterance.match(modelRegex) ?? digitsToArabic(utterance).match(modelRegex)
    if (prodMatch) {
      slots.product = `${prodMatch[1].toUpperCase()}-${prodMatch[2]}`
    } else {
      const hit = dict.products
        .filter(
          (p) =>
            utterance.toUpperCase().includes(p.model.toUpperCase()) ||
            (p.name.length >= 2 && utterance.includes(p.name))
        )
        .sort((a, b) => b.model.length - a.model.length)[0]
      if (hit) slots.product = hit.model
    }

    // 遮掉型号/单号数字后再抽数量；量词必需 —— 否则「李四来五十个」会抽出「四」
    const qtyMatch = maskCodes(utterance).match(
      /(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(?:个|只|件|台|套|箱|支|条|pcs|PCS)/
    )
    if (qtyMatch) slots.quantity = qtyMatch[1]
    else {
      const bareQty = utterance.match(/(?:来|要|订|数量|下单)[是为:：]?\s*(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)/)
      if (bareQty) slots.quantity = bareQty[1]
    }
  }

  // 单价：单价12 / 按12块 / 每个12.5
  const priceMatch = utterance.match(
    /(?:单价|价格|每个|每只|每件|按|一块|块)\s*(?:是|为|算|卖|做|走)?\s*(\d+(?:\.\d+)?)/
  )
  if (priceMatch) slots.unit_price = priceMatch[1]
  else {
    const priceAfter = utterance.match(/(\d+(?:\.\d+)?)\s*(?:块|元|块钱)\s*(?:一个|一只|一件|的价)/)
    if (priceAfter) slots.unit_price = priceAfter[1]
  }

  // 交期
  const dateMatch = utterance.match(
    /(今天|明天|后天|昨天|下周[一二三四五六日天1-7]|下下周[一二三四五六日天1-7]|本周[一二三四五六日天1-7]|这周[一二三四五六日天1-7]|[周星期礼拜][一二三四五六日天1-7]|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-\/]\d{1,2}|月底|月末|\d+\s*天内)/
  )
  if (dateMatch) slots.delivery_date = dateMatch[1]

  // 仓库
  const whMatch = utterance.match(/(华东|华南|华北|华中|西南|东北|西北)\s*仓?/)
  if (whMatch) slots.warehouse = `${whMatch[1]}仓`

  // 状态
  const statusMatch = utterance.match(/(草稿|未确认|待确认|还没确认|已确认|已下单|已出货|已发货|已取消|已作废)/)
  if (statusMatch) slots.status = statusMatch[1]

  // 订单号 / 出货单号
  const noMatch = utterance.match(/(SO[-\s]?\d{4}[-\s]?\d{3,5})/i)
  if (noMatch) {
    const no = noMatch[1].replace(/\s/g, '-').toUpperCase()
    slots.keyword = no
    slots.order_no = no
  }
  const confirmTail = utterance.match(/确认\s*(?:一下)?(?:订单)?\s*(SO[-\s]?\d{4}[-\s]?\d{3,5}|\d{3,5})/i)
  if (confirmTail) {
    slots.order_no = confirmTail[1].replace(/\s/g, '-').toUpperCase()
  }
  const dnMatch = utterance.match(/(DN[-\s]?\d{4}[-\s]?\d{3,5}|\bDN[-\s]?\d{3,5})/i)
  if (dnMatch) slots.delivery_no = dnMatch[1].replace(/\s/g, '-').toUpperCase()

  // 取消原因
  const reasonMatch = utterance.match(/(?:原因|因为|由于)[是:：]?\s*([^，,。]{2,40})/)
  if (reasonMatch) slots.reason = reasonMatch[1].trim()
  else if (/取消/.test(utterance)) {
    const after = utterance.match(/取消[^，,。]{0,20}(?:，|,|：|:)?\s*(.+)$/)
    if (after && !/SO|DN|\d{4}/i.test(after[1])) slots.reason = after[1].trim()
  }

  // 信用金额
  const amountMatch = utterance.match(/(?:金额|信用|额度|下)\s*(?:够不够|检查)?\s*([零一二两三四五六七八九十百千万\d]+(?:\.\d+)?)\s*(?:元|块)?/)
  if (amountMatch) slots.amount = amountMatch[1]
  else {
    const amt2 = utterance.match(/([零一二两三四五六七八九十百千万\d]+(?:\.\d+)?)\s*(?:元|块钱?)/)
    if (amt2 && /信用|额度/.test(utterance)) slots.amount = amt2[1]
  }

  // 原单号 —— 变更场景的串联关键词
  const originFull = utterance.match(/SO[-\s]?\d{4}[-\s]?\d{3,5}/i)
  const originTail = utterance.match(/(\d{3,5})\s*(?:那张单|那单|那张|这张单|这单|的单)/)
  if (/变更|改成|开变更/.test(utterance) && originFull) {
    slots.origin_no = originFull[0].replace(/\s/g, '-').toUpperCase()
  } else if (/变更|改成|开变更/.test(utterance) && originTail) {
    slots.origin_no = originTail[1]
  } else if (originFull && /改|变更/.test(utterance)) {
    slots.origin_no = originFull[0].replace(/\s/g, '-').toUpperCase()
  } else if (originTail && /改|变更/.test(utterance)) {
    slots.origin_no = originTail[1]
  }

  // 返回条数
  const limitMatch = utterance.match(/(?:最近|前|只要)?\s*(\d+|[零一二两三四五六七八九十]+)\s*(?:条|张|笔)/)
  if (limitMatch) slots.limit = limitMatch[1]

  // 备注兜底：只认明确的备注引导词，且内容不能是已被别的槽位吃掉的信息
  const remarkMatch = utterance.match(
    /(?:备注|注意|记得|别忘了|另外|还有|要特别的?是)\s*([^，,。]{2,30})$/
  )
  if (remarkMatch) {
    const r = remarkMatch[1].trim()
    const isNoise =
      /^\d+$/.test(r) ||
      r === slots.product ||
      r === slots.customer ||
      (slots.product !== undefined && r.includes(slots.product))
    if (!isNoise) slots.remark = r
  }

  return slots
}

// ---------------------------------------------------------------- 主入口

export interface InterpretOptions {
  tools: Map<string, ToolSchema>
  /** 完整 Formily Schema（含 title、required，UI 与消解都要用） */
  schemas: Map<string, any>
  ctx: ResolveCtx
  /** 主数据词典，用于实体链接校正 */
  dict?: ExtractDict
  /** 模型配置；为 null / provider=rules 时走规则引擎 */
  llm?: LlmSettings | null
  /** 「今天」——相对时间解析的基准 */
  today?: Date
}

const EMPTY_DICT: ExtractDict = { customers: [], products: [] }

export async function interpret(
  utterance: string,
  opts: InterpretOptions
): Promise<Interpretation> {
  const { tools, schemas, ctx, dict = EMPTY_DICT, llm = null, today } = opts
  const available = [...tools.keys()]

  // --- 0. 个人用语表：动词前置闸门（插入点 A）
  const verbLex = await lookupVerb(ctx.db, utterance, ctx.userId ?? 'owner')
  let verbFromLexicon = false
  let verb: string
  let verbConfidence: number
  if (verbLex?.verb && available.includes(verbLex.verb)) {
    verb = verbLex.verb
    verbConfidence = 0.95
    verbFromLexicon = true
  } else if (
    // D10：「记住：A 就是 B」句式强识别 —— 没有它会被误判成 customer.query / credit.check
    /记住|记一下|帮我记|记着/.test(utterance) &&
    /就是|就系|是|＝|等于/.test(utterance) &&
    available.includes('lexicon.remember')
  ) {
    verb = 'lexicon.remember'
    verbConfidence = 0.9
  } else {
    // --- 1. 意图 → 动词
    ;({ verb, confidence: verbConfidence } = detectVerb(utterance, available))
  }

  // --- 2. 槽位抽取：模型优先，规则兜底
  const ruleSlots = extractSlotsRules(utterance, dict)
  let rawSlots = ruleSlots
  let engine: 'rules' | 'llm' | 'pi' = verbFromLexicon ? 'rules' : 'rules'
  let llmTrace: Interpretation['llm']

  if (llm && llm.provider === 'openai' && llm.apiKey) {
    try {
      // Pi 风格循环（无文件/shell 工具）；失败则再试直连 llmExtract
      let usedPi = false
      try {
        const r = await piExtract(utterance, {
          settings: llm,
          tools,
          schemas,
          dict,
          today: today ?? new Date(),
        })
        if (!verbFromLexicon) {
          verb = r.verb
          verbConfidence = r.confidence
        }
        rawSlots = { ...ruleSlots, ...r.slots }
        engine = 'pi'
        llmTrace = { ms: r.ms, raw: r.raw }
        usedPi = true
      } catch {
        usedPi = false
      }
      if (!usedPi) {
        const r = await llmExtract(utterance, {
          settings: llm,
          tools,
          schemas,
          dict,
          today: today ?? new Date(),
        })
        if (!verbFromLexicon) {
          verb = r.verb
          verbConfidence = r.confidence
        }
        rawSlots = { ...ruleSlots, ...r.slots }
        engine = 'llm'
        llmTrace = { ms: r.ms, raw: r.raw }
      }
    } catch (e: any) {
      llmTrace = { ms: 0, error: String(e?.message ?? e) }
      console.warn(`⚠️  LLM 抽取失败，回落规则引擎：${e?.message ?? e}`)
    }
  }

  // --- 2b. 个人用语：若话术含已记槽位说法且抽取未覆盖，注入 raw
  {
    const slotRows = await ctx.db.personalLexeme.findMany({
      where: { userId: ctx.userId ?? 'owner', status: 'active', kind: 'slot' },
      orderBy: [{ hits: 'desc' }],
    })
    const uNorm = phraseNorm(utterance)
    for (const row of slotRows) {
      if (!row.slot || !row.phraseNorm) continue
      if (rawSlots[row.slot] !== undefined) continue
      if (uNorm.includes(row.phraseNorm) || utterance.includes(row.phrase)) {
        rawSlots[row.slot] = row.phrase
      }
    }
  }

  const tool = tools.get(verb)
  const schema = schemas.get(verb)
  if (!tool || !schema) {
    throw new Error(`动词 ${verb} 没有对应的 Schema`)
  }

  // --- 3. 逐槽消解
  const fieldBySlot: Record<string, string> = {}
  for (const [field, def] of Object.entries<any>(schema.properties ?? {})) {
    fieldBySlot[def['x-agent']?.extract ?? field] = field
  }

  const slots: SlotResult[] = []
  for (const [slot, param] of Object.entries<any>(tool.parameters.properties)) {
    const field = fieldBySlot[slot] ?? slot
    const def = schema.properties?.[field] ?? {}
    const raw = rawSlots[slot]

    if (raw !== undefined) {
      const r: Resolved = await resolveSlot(raw, param['x-resolution'], ctx, {
        enum: param.enum,
        field,
        slot,
      })
      slots.push({
        slot,
        field,
        title: param.description ?? field,
        raw,
        value: r.value,
        ...(r.label ? { label: r.label } : {}),
        confidence: r.confidence,
        source: 'user',
        required: tool.parameters.required.includes(slot),
        ...(r.candidates ? { candidates: r.candidates } : {}),
        ...(r.note ? { note: r.note } : {}),
      })
      continue
    }

    // 用户没提 → 尝试按 Schema 声明的 inferFrom 推断
    const inferred = await inferSlot(slot, param, schema, ctx)
    if (inferred) {
      slots.push({
        slot,
        field,
        title: param.description ?? field,
        raw: null,
        value: inferred.value,
        ...(inferred.label ? { label: inferred.label } : {}),
        confidence: param['x-confidenceDefault'] ?? 0.7,
        source: 'inferred',
        required: tool.parameters.required.includes(slot),
        note: inferred.note,
      })
      continue
    }

    // 有默认值 → 也算推断
    if (param.default !== undefined) {
      slots.push({
        slot,
        field,
        title: param.description ?? field,
        raw: null,
        value: param.default,
        label: String(param.default),
        confidence: 0.95,
        source: 'inferred',
        required: tool.parameters.required.includes(slot),
        note: '取 Schema 默认值',
      })
      continue
    }

    slots.push({
      slot,
      field,
      title: param.description ?? field,
      raw: null,
      value: null,
      confidence: 0,
      source: 'missing',
      required: tool.parameters.required.includes(slot),
    })
  }

  // --- 4. 缺失判定：一次问完，绝不逐个追问
  // 多行 items 已消解时，单行 product/quantity 不再必填
  const itemsResolved = slots.find((s) => s.field === 'items' || s.slot === 'items')
  const hasItems =
    Array.isArray(itemsResolved?.value) && (itemsResolved!.value as unknown[]).length > 0

  const missingSlots = slots.filter((s) => {
    if (s.source !== 'missing') return false
    if (!tool.parameters.required.includes(s.slot)) return false
    if (hasItems && (s.slot === 'product' || s.slot === 'quantity')) return false
    return true
  })
  // 歧义未决也算"缺失"—— 必须人来决定
  const ambiguous = slots.filter((s) => s.candidates && s.candidates.length > 0)

  const missing = [...new Set([...missingSlots.map((s) => s.slot), ...ambiguous.map((s) => s.slot)])]

  let question: string | undefined
  if (ambiguous.length) {
    const a = ambiguous[0]
    question = `「${a.raw}」匹配到多个${a.title}，请选择一个：`
  } else if (missingSlots.length) {
    const names = missingSlots.map((s) => s.title).join('、')
    question = `还需要：${names}。一次说全就行，比如「客户张三，A-100，120个」。`
  }
  if (verbFromLexicon) {
    const prefix = verbLex!.note
    question = question ? `${prefix}。${question}` : `${prefix} → ${schema.title ?? verb}`
  }

  return {
    verb,
    verbTitle: schema.title ?? verb,
    verbConfidence,
    risk: tool.risk,
    requiresConfirm: tool.requiresConfirm,
    slots,
    missing,
    ...(question ? { question } : {}),
    ready: missing.length === 0 && !ambiguous.length,
    engine,
    ...(llmTrace ? { llm: llmTrace } : {}),
  }
}

// ---------------------------------------------------------------- 推断

/**
 * 按 Schema 声明的 inferFrom 做推断。
 * 推断值必须在确认页高亮标出，且 confidence < 用户明说的值 —— 绝不静默落库。
 */
async function inferSlot(
  slot: string,
  param: any,
  schema: any,
  ctx: ResolveCtx
): Promise<{ value: unknown; label: string; note: string } | null> {
  const fieldEntry = Object.entries<any>(schema.properties ?? {}).find(
    ([, d]) => (d['x-agent']?.extract ?? '') === slot
  )
  const field = fieldEntry?.[0]
  if (!field) return null
  const inferFrom = schema.properties?.[field]?.['x-agent']?.inferFrom

  if (!inferFrom) return null

  if (inferFrom === 'customer_price_group' || inferFrom === 'customer_price') {
    // 从已知客户的最近订单 / 牌价推断单价
    const customerSlot = Object.entries<any>(schema.properties ?? {}).find(
      ([, d]) => d['x-agent']?.extract === 'customer'
    )
    const rawCustomer = (schema as any).__rawCustomer
    void customerSlot
    void rawCustomer
    return null // 需要客户先确定；实现见 hydrateInference
  }

  if (inferFrom === 'customer_last_order') {
    // 需要客户 ID，见 hydrateInference
    return null
  }

  return null
}

/**
 * 二次推断：客户确定之后，才能推断单价与仓库。
 * 单独抽出来是因为它依赖消解结果，必须串行执行。
 */
export async function hydrateInference(
  slots: SlotResult[],
  schema: any,
  ctx: ResolveCtx
): Promise<SlotResult[]> {
  const customerSlot = slots.find((s) => s.slot === 'customer')
  if (!customerSlot?.value) return slots

  const customer = await ctx.db.customer.findUnique({
    where: { id: String(customerSlot.value) },
    include: {
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { items: { include: { product: true } } },
      },
    },
  })
  if (!customer) return slots

  const lastOrder = customer.orders[0]

  return slots.map((s) => {
    const fieldDef = schema.properties?.[s.field]?.['x-agent']
    if (!fieldDef?.inferFrom || s.source === 'user') return s

    // 仓库 ← 客户最近订单 / 客户主数据
    if (fieldDef.inferFrom === 'customer_last_order') {
      const value = lastOrder?.warehouse ?? customer.lastWarehouse
      if (!value) return s
      return {
        ...s,
        value,
        label: value,
        source: 'inferred' as const,
        confidence: fieldDef.confidenceDefault ?? 0.8,
        note: lastOrder
          ? `按 ${customer.name} 最近一单 ${lastOrder.no} 推断`
          : `按客户主数据默认仓库推断`,
      }
    }

    // 单价 ← 该客户最近一次买同款的价格，没有则回落牌价
    if (fieldDef.inferFrom === 'customer_price_group') {
      const productSlot = slots.find((x) => x.slot === 'product')
      let price: number | null = null
      let note = ''

      if (lastOrder && productSlot?.value) {
        const hit = lastOrder.items.find((i) => i.productId === String(productSlot.value))
        if (hit) {
          price = hit.unitPrice
          note = `按 ${customer.name} 上一单 ${lastOrder.no} 的成交价推断`
        }
      }
      if (price === null && productSlot?.value) {
        const p = ctx.db.product // 下面 await 不了，改为同步取已缓存
        void p
      }
      if (price === null) return s
      return {
        ...s,
        value: price,
        label: `¥${price}`,
        source: 'inferred' as const,
        confidence: fieldDef.confidenceDefault ?? 0.7,
        note,
      }
    }

    return s
  })
}

/**
 * 单价兜底：客户无历史成交价时，取产品牌价，但置信度降到 0.6
 * （因为牌价不等于成交价，必须让人在确认页看到并复核）
 */
export async function applyListPriceFallback(
  slots: SlotResult[],
  schema: any,
  ctx: ResolveCtx
): Promise<SlotResult[]> {
  const priceSlot = slots.find((s) => s.slot === 'unit_price')
  const productSlot = slots.find((s) => s.slot === 'product')
  const customerSlot = slots.find((s) => s.slot === 'customer')

  if (!priceSlot || !productSlot?.value) return slots
  if (priceSlot.source === 'user') return slots
  if (priceSlot.value !== null && priceSlot.note?.includes('成交价')) return slots

  // 客户还没定（缺失或歧义未决）时不推断价格 ——
  // 「该客户无历史成交价」这句话在客户未知时纯属编造
  if (!customerSlot?.value) {
    return slots.map((s) =>
      s.slot === 'unit_price'
        ? { ...s, value: null, source: 'missing' as const, confidence: 0, note: undefined, label: undefined }
        : s
    )
  }

  const product = await ctx.db.product.findUnique({
    where: { id: String(productSlot.value) },
  })
  if (!product) return slots

  return slots.map((s) =>
    s.slot === 'unit_price'
      ? {
          ...s,
          value: product.price,
          label: `¥${product.price}`,
          source: 'inferred' as const,
          confidence: 0.6,
          note: `该客户无历史成交价，暂取牌价 ¥${product.price}（请复核）`,
        }
      : s
  )
}
