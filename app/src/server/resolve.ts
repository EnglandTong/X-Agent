/**
 * 消解器（Resolver）
 *
 * 架构位置：Agent 层与领域层之间的一道「翻译 + 校验」闸门。
 *
 * 核心原则：模型只负责「意会」，代码负责「确指」。
 *   模型输出 "张三"  →  消解器查库 → { id: "c1...", name: "张三", code: "C001" }
 *   模型输出 "一百二" →  消解器归一 → 120
 *   模型输出 "下周三" →  消解器基于今天算 → "2026-09-16"
 *
 * 这样做的好处：
 *   1. 模型不需要知道数据库里的主键，准确率大幅提升（这是 1.7B 能用的关键）
 *   2. 消解规则是可测试、可审计的确定性代码，出问题改代码不改模型
 *   3. 消解失败时返回 candidates 交给人选，而不是让模型瞎猜
 */

import type { PrismaClient } from '@prisma/client'
import { lookupSlot, validateSlotTarget } from './lexicon'

// ---------------------------------------------------------------- 类型

export interface Resolved<T = unknown> {
  ok: boolean
  value: T | null
  /** 展示给用户看的文本，如 "张三 (C001)" */
  label?: string
  /** 0-1，用于确认页区分「你说的」与「系统推断的」 */
  confidence: number
  /** 消解不唯一时的候选，交给 UI 弹选择 */
  candidates?: Array<{ id: string; label: string; hint?: string }>
  /** 消解过程中的人话说明，进 Trace 面板 */
  note?: string
}

const fail = (note: string, candidates?: Resolved['candidates']): Resolved => ({
  ok: false,
  value: null,
  confidence: 0,
  ...(candidates ? { candidates } : {}),
  note,
})

const ok = <T>(value: T, label: string, confidence: number, note?: string): Resolved<T> => ({
  ok: true,
  value,
  label,
  confidence,
  ...(note ? { note } : {}),
})

// ---------------------------------------------------------------- 字符串相似度

/** 归一化：去空格、去横杠、全角转半角、大写化 */
function norm(s: string): string {
  return s
    .replace(/[\s\-_．。]/g, '')
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .trim()
}

/** Levenshtein 编辑距离（归一化后按字符比较） */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  const cur = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur.slice()
  }
  return prev[n]
}

/** 相似度 0-1：1 - 编辑距离 / 较长串长度；包含关系额外加分 */
function similarity(query: string, target: string): number {
  const q = norm(query)
  const t = norm(target)
  if (!q || !t) return 0
  if (q === t) return 1
  if (t.includes(q)) return 0.9 + 0.1 * (q.length / t.length)
  if (q.includes(t)) return 0.85
  return Math.max(0, 1 - editDistance(q, t) / Math.max(q.length, t.length))
}

// ---------------------------------------------------------------- 实体消解

interface MatchCandidate {
  id: string
  label: string
  hint: string
  score: number
}

/**
 * 模糊匹配实体（客户 / 产品）。
 *
 * 多路打分取最高：名称 / 编码 / 型号 / 别名（型号去横杠等变体）。
 * **编码精确命中优先**（RFTS SoR：按 code 消解）。
 * 命中多个且分差 < 0.08 时判为歧义，返回 candidates 让人选 —— 绝不自动选中。
 */
async function fuzzyEntity(
  db: PrismaClient,
  kind: 'customer' | 'product',
  raw: string
): Promise<Resolved<string>> {
  const q = norm(raw)
  if (!q) return fail('输入为空') as Resolved<string>

  const scored: MatchCandidate[] = []

  if (kind === 'customer') {
    const rows = await db.customer.findMany()
    // 编码精确 / 高置信优先
    const codeExact = rows.filter((c) => norm(c.code) === q)
    if (codeExact.length === 1) {
      const c = codeExact[0]
      return ok(
        c.id,
        `${c.name}（${c.code}）`,
        0.99,
        `"${raw}" → 编码精确 ${c.code}`
      )
    }
    if (codeExact.length > 1) {
      return fail(
        `"${raw}" 匹配到多个客户编码，请选择`,
        codeExact.map((c) => ({
          id: c.id,
          label: `${c.name}（${c.code}）`,
          hint: `${c.level} 级客户`,
        }))
      ) as Resolved<string>
    }

    for (const c of rows) {
      const sName = similarity(q, c.name)
      const sCode = similarity(q, c.code)
      // 编码相似度加权高于名称，减少「张」类短名误绑
      const score = Math.max(sName * 0.92, sCode)
      if (score >= 0.55) {
        scored.push({
          id: c.id,
          label: `${c.name}（${c.code}）`,
          hint: `${c.level} 级客户 · 信用额度 ${c.creditLimit.toLocaleString('zh-CN')}`,
          score,
        })
      }
    }
  } else {
    const rows = await db.product.findMany()
    const modelExact = rows.filter((p) => norm(p.model) === q)
    if (modelExact.length === 1) {
      const p = modelExact[0]
      return ok(p.id, `${p.model} ${p.name}`, 0.99, `"${raw}" → 型号精确 ${p.model}`)
    }
    if (modelExact.length > 1) {
      return fail(
        `"${raw}" 匹配到多个产品型号，请选择`,
        modelExact.map((p) => ({
          id: p.id,
          label: `${p.model} ${p.name}`,
          hint: `牌价 ¥${p.price}`,
        }))
      ) as Resolved<string>
    }

    for (const p of rows) {
      const sModel = similarity(q, p.model)
      const sName = similarity(q, p.name) * 0.85
      const score = Math.max(sModel, sName)
      if (score >= 0.55) {
        scored.push({
          id: p.id,
          label: `${p.model} ${p.name}`,
          hint: `牌价 ¥${p.price} / ${p.unit}`,
          score,
        })
      }
    }
  }

  if (scored.length === 0) {
    return fail(`没有找到匹配的${kind === 'customer' ? '客户' : '产品'}："${raw}"`) as Resolved<string>
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]

  // 歧义判定：次优解与最优解分差过小 → 必须人工决策
  if (scored.length > 1 && top.score - scored[1].score < 0.08) {
    return fail(`"${raw}" 匹配到多个${kind === 'customer' ? '客户' : '产品'}，请选择`, scored) as Resolved<string>
  }

  return ok(
    top.id,
    top.label,
    top.score >= 0.99 ? 0.98 : Math.round(top.score * 90) / 100,
    `"${raw}" → ${top.label}`
  )
}

// ---------------------------------------------------------------- 标量消解

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/**
 * 中文数字归一。覆盖口头表达的高频写法：
 *   一百二十 / 一百二 / 两百 / 三十五 / 一千二 / 12 / 1,200
 * 不追求完备 —— 覆盖不到的部分走「确认页人工改」，这比让模型猜安全得多。
 */
export function parseChineseNumber(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null

  const s = input.replace(/[,，\s]/g, '').trim()

  // 纯阿拉伯数字
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)

  // 中文数字
  if (/^[零一二两三四五六七八九十百千万]+$/.test(s)) {
    let total = 0
    let section = 0
    let number = 0
    for (const ch of s) {
      const d = CN_DIGITS[ch]
      if (d !== undefined && d < 10) {
        number = d
      } else if (d === 10) {
        // "十" 开头视为 10，否则 10 * 前一位
        section += (number === 0 ? 1 : number) * 10
        number = 0
      } else if (ch === '百') {
        section += (number === 0 ? 1 : number) * 100
        number = 0
      } else if (ch === '千') {
        section += (number === 0 ? 1 : number) * 1000
        number = 0
      } else if (ch === '万') {
        section += number
        total += section * 10000
        section = 0
        number = 0
      }
    }
    total += section + number
    return total > 0 ? total : null
  }

  // 阿拉伯 + 单位，如 "1.2万" "3k"
  const m = s.match(/^([\d.]+)([kK千wW万])$/)
  if (m) {
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    if (unit === 'k') return n * 1000
    if (unit === 'w' || unit === '万') return n * 10000
    if (unit === '千') return n * 1000
  }

  // 兜底：抽取第一个数字串
  const loose = s.match(/\d+(\.\d+)?/)
  return loose ? Number(loose[0]) : null
}

/** 日期解析：相对时间基于「今天」，绝对时间直接归一 */
export function parseDate(input: string, today = new Date()): string | null {
  const s = input.trim()

  const iso = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/)
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  }

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const shift = (days: number) => {
    const d = new Date(base)
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  if (/今天/.test(s)) return shift(0)
  if (/明天|明日/.test(s)) return shift(1)
  if (/后天/.test(s)) return shift(2)
  if (/昨天|昨日/.test(s)) return shift(-1)

  // "下周三" / "本周三" / "周三"
  const weekMatch = s.match(/(下{1,2}|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
  if (weekMatch) {
    const targetMap: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
      日: 7, 天: 7, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
    }
    const target = targetMap[weekMatch[2]]
    const current = base.getDay() === 0 ? 7 : base.getDay()
    let delta = target - current
    if (weekMatch[1] === '下') delta += 7
    else if (weekMatch[1] === '下下') delta += 14
    else if (delta < 0) delta += 7
    return shift(delta)
  }

  const daysMatch = s.match(/(\d+)\s*天[后内]/)
  if (daysMatch) return shift(Number(daysMatch[1]))

  if (/月底|月末/.test(s)) {
    const d = new Date(base.getFullYear(), base.getMonth() + 1, 0)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const md = s.match(/^(\d{1,2})[/-](\d{1,2})$/) ?? s.match(/^(\d{1,2})月(\d{1,2})[日号]?$/)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    let year = base.getFullYear()
    if (month < base.getMonth() + 1) year += 1
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

// ---------------------------------------------------------------- 状态别名

const STATUS_ALIASES: Record<string, string> = {
  DRAFT: 'DRAFT', 草稿: 'DRAFT', 未确认: 'DRAFT', 待确认: 'DRAFT', 还没确认: 'DRAFT', 新建: 'DRAFT',
  CONFIRMED: 'CONFIRMED', 已确认: 'CONFIRMED', 确认: 'CONFIRMED', 已下单: 'CONFIRMED',
  PARTIALLY_SHIPPED: 'PARTIALLY_SHIPPED', 部分出货: 'PARTIALLY_SHIPPED', 部分发货: 'PARTIALLY_SHIPPED',
  SHIPPED: 'SHIPPED', 已出货: 'SHIPPED', 已发货: 'SHIPPED', 出货: 'SHIPPED',
  CANCELLED: 'CANCELLED', 已取消: 'CANCELLED', 取消: 'CANCELLED', 作废: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED', 已变更: 'SUPERSEDED', 被取代: 'SUPERSEDED',
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  PARTIALLY_SHIPPED: '部分出货',
  SHIPPED: '已出货',
  CANCELLED: '已取消',
  SUPERSEDED: '已变更',
}

// ---------------------------------------------------------------- 主入口

export interface ResolveCtx {
  db: PrismaClient
  /** 供相对日期解析使用，便于测试时固定 */
  today?: Date
  /** 个人用语表用户；默认 owner */
  userId?: string
}

/**
 * 按 Schema 声明的 resolution 策略消解单个槽位。
 * 策略名写在 Schema 的 x-agent.resolution 里 —— 字段怎么消解，由 Schema 说了算。
 * 个人用语表在 fuzzy / enum 之前优先命中。
 */
export async function resolveSlot(
  raw: unknown,
  resolution: string | undefined,
  ctx: ResolveCtx,
  meta: { enum?: string[]; field: string; slot?: string } = { field: '' }
): Promise<Resolved> {
  if (raw === undefined || raw === null || raw === '') {
    return fail('未提供')
  }

  const userId = ctx.userId ?? 'owner'
  const slotName = meta.slot ?? meta.field

  // 插入点 B：个人用语优先于系统消解
  if (
    resolution === 'fuzzy_customer' ||
    resolution === 'fuzzy_product' ||
    resolution === 'enum' ||
    resolution === 'enum_alias'
  ) {
    const lexSlot =
      resolution === 'fuzzy_customer'
        ? 'customer'
        : resolution === 'fuzzy_product'
          ? 'product'
          : slotName === 'warehouseId' || slotName === 'warehouse'
            ? 'warehouse'
            : slotName
    const hit = await lookupSlot(ctx.db, String(raw), lexSlot, userId)
    if (hit && (await validateSlotTarget(ctx.db, hit))) {
      const target = hit.targetId!
      if (
        (resolution === 'enum' || resolution === 'enum_alias') &&
        meta.enum &&
        !meta.enum.includes(target)
      ) {
        // 用语目标不在枚举内 → 忽略，走系统消解
      } else {
        return ok(
          target,
          hit.targetLabel ?? target,
          0.95,
          `${hit.note} → ${hit.targetLabel ?? target}`
        )
      }
    }
  }

  switch (resolution) {
    case 'fuzzy_customer':
      return fuzzyEntity(ctx.db, 'customer', String(raw))
    case 'fuzzy_product':
      return fuzzyEntity(ctx.db, 'product', String(raw))

    case 'number_normalize': {
      const n = parseChineseNumber(raw as string | number)
      return n === null
        ? fail(`无法把 "${raw}" 解析为数字`)
        : ok(n, String(n), 0.95, `"${raw}" → ${n}`)
    }

    /**
     * 订单号查找 —— 变更单的串联关键词。
     * 支持完整单号（SO-2026-1007）与尾号片段（1007），后者会列出候选。
     */
    case 'order_lookup': {
      const s = String(raw).trim().toUpperCase().replace(/\s/g, '-')
      const all = await ctx.db.order.findMany({
        orderBy: { no: 'desc' },
        select: { no: true, status: true, totalAmount: true, customer: { select: { name: true } } },
      })
      const exact = all.filter((o) => o.no.toUpperCase() === s)
      if (exact.length === 1) {
        const o = exact[0]
        return ok(o.no, o.no, 0.98, `"${raw}" → ${o.no}（${o.customer.name} ¥${o.totalAmount}）`)
      }
      const fuzzy = all.filter((o) => o.no.toUpperCase().includes(s))
      if (fuzzy.length === 1) {
        const o = fuzzy[0]
        return ok(o.no, o.no, 0.85, `"${raw}" → ${o.no}（${o.customer.name} ¥${o.totalAmount}）`)
      }
      if (fuzzy.length > 1) {
        return fail(
          `"${raw}" 匹配到多张订单，请选择`,
          fuzzy.slice(0, 5).map((o) => ({
            id: o.no,
            label: o.no,
            hint: `${o.customer.name} · ${STATUS_LABEL[o.status] ?? o.status} · ¥${o.totalAmount}`,
          }))
        )
      }
      return fail(`找不到订单 "${raw}"`)
    }

    case 'date_parse': {
      const d = parseDate(String(raw), ctx.today)
      return d === null
        ? fail(`无法把 "${raw}" 解析为日期`)
        : ok(d, d, 0.9, `"${raw}" → ${d}`)
    }

    case 'enum':
    case 'enum_alias': {
      const s = String(raw).trim()
      if (meta.enum?.includes(s)) return ok(s, STATUS_LABEL[s] ?? s, 0.98)
      // 走别名表（口语 → 枚举）
      const hit = STATUS_ALIASES[s] ?? STATUS_ALIASES[norm(s)]
      if (hit && meta.enum?.includes(hit)) {
        return ok(hit, STATUS_LABEL[hit] ?? hit, 0.9, `"${raw}" → ${STATUS_LABEL[hit]}`)
      }
      // 模糊兜底：包含匹配
      for (const [alias, value] of Object.entries(STATUS_ALIASES)) {
        if (meta.enum?.includes(value) && s.includes(alias)) {
          return ok(value, STATUS_LABEL[value] ?? value, 0.8, `"${raw}" → ${STATUS_LABEL[value]}`)
        }
      }
      return fail(`"${raw}" 不是有效的${meta.field === 'status' ? '订单状态' : '选项'}`, 
        meta.enum?.map((e) => ({ id: e, label: STATUS_LABEL[e] ?? e })))
    }

    case 'passthrough':
      return ok(String(raw), String(raw), 0.99)

    case 'lookup_price_list': {
      const n = parseChineseNumber(raw as string | number)
      return n === null
        ? fail(`无法把 "${raw}" 解析为单价`)
        : ok(n, `¥${n}`, 0.8, `"${raw}" → ¥${n}`)
    }

    /**
     * 多行订单：raw 为 JSON 数组或已是数组。
     * 元素可用 product/productId + quantity/qty；消解后统一为 {productId, qty, unitPrice?}。
     */
    case 'order_line_items': {
      let parsed: any[]
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as any[])
      } catch {
        return fail(`无法解析多行明细 "${String(raw).slice(0, 80)}"`)
      }
      if (!Array.isArray(parsed) || !parsed.length) {
        return fail('多行明细为空')
      }
      const out: Array<{ productId: string; qty: number; unitPrice?: number }> = []
      const labels: string[] = []
      for (const line of parsed) {
        const prodRaw = line.product ?? line.productId ?? line.model
        if (!prodRaw) return fail('订单行缺少产品')
        const prod = await fuzzyEntity(ctx.db, 'product', String(prodRaw))
        if (!prod.ok || !prod.value) {
          return fail(prod.note ?? `产品「${prodRaw}」无法消解`, prod.candidates)
        }
        const qtyRaw = line.qty ?? line.quantity
        const qty = parseChineseNumber(qtyRaw as string | number)
        if (qty === null || qty < 1) {
          return fail(`订单行数量无效：「${qtyRaw}」`)
        }
        const row: { productId: string; qty: number; unitPrice?: number } = {
          productId: String(prod.value),
          qty,
        }
        if (line.unitPrice != null && line.unitPrice !== '') {
          const up = parseChineseNumber(line.unitPrice as string | number)
          if (up !== null) row.unitPrice = up
        }
        out.push(row)
        labels.push(`${prod.label ?? prodRaw}×${qty}`)
      }
      return ok(out, labels.join('、'), 0.92, `多行 ${out.length}：${labels.join('、')}`)
    }

    default:
      return ok(raw as string, String(raw), 0.9)
  }
}
