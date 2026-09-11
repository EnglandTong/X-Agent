/**
 * 微信订单截图 OCR 文本解析（G2 · 单场景）
 *
 * 输入 = OCR 原话（多行）；输出 = 结构化字段 + 可送进 interpret 的一句话。
 * 不做 ID 猜测 —— 只抽原话片段，消解仍走 resolve。
 */

export interface WechatOrderFields {
  customer?: string
  product?: string
  quantity?: string
  orderNo?: string
  warehouse?: string
  amount?: string
  remark?: string
}

const CUSTOMER_KEYS = /^(?:买家|客户|收货人|联系人)/
const PRODUCT_KEYS = /^(?:商品|产品|货品|型号|物料)/
const QTY_KEYS = /^(?:数量|件数)/
const ORDER_KEYS = /^(?:订单号|单号|订单编号)/
const AMOUNT_KEYS = /^(?:金额|合计|总价|实付)/

function lineValue(line: string, keyRe: RegExp): string | undefined {
  const m = line.match(new RegExp(`${keyRe.source}[:：\\s]+(.+)$`))
  return m?.[1]?.trim() // keyRe 须用非捕获组，否则 [1] 会是关键词而非值
}

/** 从 OCR 多行文本抽字段 */
export function parseWechatOrderText(text: string): WechatOrderFields {
  const fields: WechatOrderFields = {}
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (!fields.customer && CUSTOMER_KEYS.test(line)) {
      fields.customer = lineValue(line, CUSTOMER_KEYS) ?? line.replace(CUSTOMER_KEYS, '').replace(/^[:：\s]+/, '').trim()
    }
    if (!fields.product && PRODUCT_KEYS.test(line)) {
      const v = lineValue(line, PRODUCT_KEYS) ?? line.replace(PRODUCT_KEYS, '').replace(/^[:：\s]+/, '').trim()
      const model = v.match(/([A-Za-z]\s*-?\s*\d{3})/)
      if (model) fields.product = model[1].replace(/\s/g, '').toUpperCase()
      else fields.product = v.split(/\s+/)[0]
    }
    if (!fields.quantity && QTY_KEYS.test(line)) {
      const v = lineValue(line, QTY_KEYS) ?? ''
      const q = v.match(/(\d+|[零一二两三四五六七八九十百千万]+)/)
      if (q) fields.quantity = q[1]
    }
    if (!fields.orderNo && ORDER_KEYS.test(line)) {
      const v = lineValue(line, ORDER_KEYS) ?? ''
      const no = v.match(/SO[-\s]?\d{4}[-\s]?\d{3,5}/i)
      if (no) fields.orderNo = no[0].replace(/\s/g, '-').toUpperCase()
    }
    if (!fields.amount && AMOUNT_KEYS.test(line)) {
      const v = lineValue(line, AMOUNT_KEYS) ?? ''
      const a = v.match(/[\d.]+/)
      if (a) fields.amount = a[0]
    }
    const wh = line.match(/(华东|华南|华北|华中)\s*仓/)
    if (wh && !fields.warehouse) fields.warehouse = `${wh[1]}仓`
  }

  if (!fields.customer || !fields.product) {
    const inline = text.match(
      /([^\s，,]{2,8})\s*[·•]\s*([A-Za-z]\s*-?\s*\d{3})\s*[x×]\s*(\d+|[零一二两三四五六七八九十百千万]+)/i
    )
    if (inline) {
      if (!fields.customer) fields.customer = inline[1]
      if (!fields.product) fields.product = inline[2].replace(/\s/g, '').toUpperCase()
      if (!fields.quantity) fields.quantity = inline[3]
    }
  }

  return fields
}

/** 把解析结果收成一句 interpret 能吃的口语 */
export function wechatOrderToUtterance(fields: WechatOrderFields): string {
  if (fields.orderNo && fields.quantity) {
    return `订单${fields.orderNo}出${fields.quantity}个`
  }
  let s = ''
  if (fields.customer) s += `给${fields.customer}`
  if (fields.quantity && fields.product) s += `来${fields.quantity}个${fields.product}`
  else if (fields.product) s += `来${fields.product}`
  else if (fields.quantity) s += `来${fields.quantity}个`
  if (fields.warehouse) s += `，${fields.warehouse}`
  return s
}

/** OCR 文本里可能是别名的片段（供 B 层 candidate） */
export function suggestAliasPhrases(
  fields: WechatOrderFields,
  ocrText: string
): Array<{ phrase: string; slot: 'customer' | 'product' | 'warehouse' }> {
  const out: Array<{ phrase: string; slot: 'customer' | 'product' | 'warehouse' }> = []
  const seen = new Set<string>()
  const add = (phrase: string | undefined, slot: 'customer' | 'product' | 'warehouse') => {
    const p = phrase?.trim()
    if (!p || p.length < 2 || seen.has(p)) return
    seen.add(p)
    out.push({ phrase: p, slot })
  }
  add(fields.customer, 'customer')
  add(fields.product, 'product')
  add(fields.warehouse, 'warehouse')
  for (const line of ocrText.split(/\r?\n/)) {
    const m = line.match(/^(买家|客户)[:：]\s*(.+)$/)
    if (m) add(m[2].trim(), 'customer')
  }
  return out
}
