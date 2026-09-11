/**
 * ASR 文本规整 —— 把耳朵听歪的型号/单号/编码读法归一回主数据写法。
 *
 * 落点：`/api/interpret` 入口（见决策 #16）。**不**放进 `asr.ts`：
 * 浏览器 Web Speech 一样会把型号听歪，两只耳朵都要救。
 *
 * 典型变换（CER 实测，SenseVoice）：
 *   「a 杠一百」              → A-100
 *   「a 一 零 零」            → A-100
 *   「B两百」                → B-200
 *   「s o 杠二零二六杠幺零零七」→ SO-2026-1007
 *   「c零零一」              → C001
 *
 * 不做的事：
 *   - 不改数量口语（「来一百个」里的「一百」必须留着给消解器）
 *   - 不碰客户中文名（「张三」本来就对；同音「章三」是消解层的事）
 *   - 不在 asr.ts 里做 —— 评测 hyp 仍是原始识别结果
 */

import { parseChineseNumber } from './resolve'

export interface AsrNormalizeDict {
  products: Array<{ model: string }>
  customers: Array<{ code: string }>
  /** 额外词条（热词表 / 订单号样本），可选 */
  extras?: string[]
}

export interface AsrReplacement {
  from: string
  to: string
}

export interface AsrNormalizeResult {
  text: string
  changed: boolean
  replacements: AsrReplacement[]
}

/** 单字读法 → 数字（含「幺」；不含「十/百/千」——那些走整段中文数字解析） */
const DIGIT_CHAR: Record<string, string> = {
  零: '0',
  〇: '0',
  '○': '0',
  洞: '0',
  一: '1',
  幺: '1',
  壹: '1',
  二: '2',
  两: '2',
  贰: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
}

const SEP = String.raw`(?:\s*(?:杠|橫杠|横杠|破折号|-|—|－)\s*|\s+)`

/** 一段中文数字读法 → 阿拉伯数字串；优先整段「一百」类，否则逐字「一零零」 */
export function spokenDigitsToArabic(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '')
  if (!compact) return null
  if (/^\d+$/.test(compact)) return compact

  // 含「十/百/千/万」→ 整段中文数字（一百、两百、一千二…）
  if (/[十百千万]/.test(compact)) {
    const n = parseChineseNumber(compact)
    return n === null ? null : String(Math.trunc(n))
  }

  // 逐字：一零零 / 幺零零七 / 二零二六
  if (/^[零〇○洞一幺壹二两贰三四五六七八九]+$/.test(compact)) {
    return [...compact].map((c) => DIGIT_CHAR[c] ?? '').join('')
  }

  return null
}

/** 把「A」「SO」「C001」这类规范码拆成可读的字母段 + 数字段 */
function splitCodeParts(code: string): Array<{ kind: 'letters' | 'digits'; value: string }> {
  const parts: Array<{ kind: 'letters' | 'digits'; value: string }> = []
  const re = /([A-Za-z]+)|(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    if (m[1]) parts.push({ kind: 'letters', value: m[1].toUpperCase() })
    else if (m[2]) parts.push({ kind: 'digits', value: m[2] })
  }
  return parts
}

/** 数字段的口语变体（「100」→ 一百 / 一零零 / 幺零零） */
function digitSpokenVariants(digits: string): string[] {
  const out = new Set<string>([digits])
  const byChar = [...digits]
    .map((d) => {
      const map: Record<string, string[]> = {
        '0': ['零', '〇'],
        '1': ['一', '幺'],
        '2': ['二', '两'],
        '3': ['三'],
        '4': ['四'],
        '5': ['五'],
        '6': ['六'],
        '7': ['七'],
        '8': ['八'],
        '9': ['九'],
      }
      return map[d] ?? [d]
    })
  // 笛卡尔积会爆炸；只生成「全一」与「全幺」两条主路径 + 阿拉伯原文
  const pick = (preferYao: boolean) =>
    byChar
      .map((opts, i) => {
        if (opts.length === 1) return opts[0]
        // 1：优先 幺（电话读法，SenseVoice 常出）；另一条用 一
        if (opts.includes('幺') && opts.includes('一')) return preferYao ? '幺' : '一'
        if (opts.includes('两') && opts.includes('二')) return preferYao ? '二' : '两'
        return opts[0]
      })
      .join('')
  out.add(pick(true))
  out.add(pick(false))

  const asNumber = Number(digits)
  if (Number.isFinite(asNumber) && asNumber >= 10 && !digits.startsWith('0')) {
    // 整段中文：100→一百，200→二百/两百
    const cn = arabicToSimpleCn(asNumber)
    if (cn) {
      out.add(cn)
      if (cn.startsWith('二')) out.add('两' + cn.slice(1))
    }
  }
  return [...out]
}

/** 小整数 → 简单中文（覆盖型号/单号里常见的两三位） */
function arabicToSimpleCn(n: number): string | null {
  if (n < 10) {
    return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][n] ?? null
  }
  if (n < 20) return n === 10 ? '十' : '十' + arabicToSimpleCn(n % 10)
  if (n < 100) {
    const tens = Math.floor(n / 10)
    const ones = n % 10
    return arabicToSimpleCn(tens)! + '十' + (ones ? arabicToSimpleCn(ones) : '')
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100)
    const rest = n % 100
    let s = arabicToSimpleCn(hundreds)! + '百'
    if (rest === 0) return s
    if (rest < 10) return s + '零' + arabicToSimpleCn(rest)
    return s + arabicToSimpleCn(rest)
  }
  if (n < 10000) {
    const thousands = Math.floor(n / 1000)
    const rest = n % 1000
    let s = arabicToSimpleCn(thousands)! + '千'
    if (rest === 0) return s
    if (rest < 100) return s + '零' + arabicToSimpleCn(rest)
    return s + arabicToSimpleCn(rest)
  }
  // 年份类四位：逐字即可，不走这一支
  return null
}

function lettersSpokenVariants(letters: string): string[] {
  const u = letters.toUpperCase()
  const l = letters.toLowerCase()
  const spacedU = u.split('').join(' ')
  const spacedL = l.split('').join(' ')
  return [...new Set([u, l, spacedU, spacedL, spacedU.toLowerCase()])]
}

/**
 * 为一个规范码生成「耳朵可能吐出的」表面形式。
 * 匹配时会再做空白折叠，所以这里不必穷举所有空格位置。
 */
export function spokenVariantsOf(code: string): string[] {
  const parts = splitCodeParts(code)
  if (!parts.length) return []

  const segVariants: string[][] = parts.map((p) =>
    p.kind === 'letters' ? lettersSpokenVariants(p.value) : digitSpokenVariants(p.value)
  )

  // 段与段之间的连接符变体
  const joiners = ['杠', ' 杠 ', '横杠', '-', ' - ', '']

  const out = new Set<string>()
  // 限制组合数：每段最多取前 4 个变体
  const capped = segVariants.map((vs) => vs.slice(0, 4))

  function walk(i: number, acc: string) {
    if (i >= capped.length) {
      if (acc) out.add(acc)
      return
    }
    for (const seg of capped[i]) {
      if (i === 0) walk(1, seg)
      else {
        for (const j of joiners) walk(i + 1, acc + j + seg)
      }
    }
  }
  walk(0, '')

  // 额外：整码去横杠 / 小写（A100、a100）
  out.add(code)
  out.add(code.toLowerCase())
  out.add(code.replace(/-/g, ''))
  out.add(code.replace(/-/g, '').toLowerCase())
  out.add(code.replace(/-/g, ' '))

  return [...out].filter((v) => v && v !== code)
}

/** 折叠空白，便于「a  杠  一百」命中「a杠一百」 */
function foldWs(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

interface LexEntry {
  canonical: string
  /** 已 fold 的口语表面 */
  folded: string
  /** 原始表面（用于 replacements.from 展示；取最长可读的一条） */
  surface: string
}

function buildLexicon(dict: AsrNormalizeDict): LexEntry[] {
  const codes = new Set<string>()
  for (const p of dict.products) {
    if (p.model?.trim()) codes.add(p.model.trim().toUpperCase())
  }
  for (const c of dict.customers) {
    if (c.code?.trim()) codes.add(c.code.trim().toUpperCase())
  }
  for (const e of dict.extras ?? []) {
    const t = e.trim()
    // 只收「像编码」的：含字母+数字，或纯编码形态
    if (/[A-Za-z]/.test(t) && /\d/.test(t)) codes.add(t.toUpperCase())
  }

  const entries: LexEntry[] = []
  for (const code of codes) {
    for (const v of spokenVariantsOf(code)) {
      const folded = foldWs(v)
      if (!folded || folded === foldWs(code)) continue
      // 太短的表面易误伤（单字母）
      if (folded.length < 2) continue
      entries.push({ canonical: code, folded, surface: v })
    }
  }
  // 长表面优先，避免短码抢先吃掉长码的前缀
  entries.sort((a, b) => b.folded.length - a.folded.length)
  return entries
}

/**
 * 词典反查：在原文里找口语表面，换成规范码。
 * 用 fold 后的滑动匹配，写回时保留命中区间两端的原文切片。
 */
function applyLexicon(text: string, entries: LexEntry[]): { text: string; replacements: AsrReplacement[] } {
  if (!entries.length) return { text, replacements: [] }

  const folded = foldWs(text)
  // 建立 fold 下标 → 原文下标 的映射
  const foldToRaw: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    foldToRaw.push(i)
  }

  const replacements: AsrReplacement[] = []
  const used = new Array(folded.length).fill(false)
  const inserts: Array<{ start: number; end: number; to: string; from: string }> = []

  for (const e of entries) {
    let from = 0
    while (from < folded.length) {
      const idx = folded.indexOf(e.folded, from)
      if (idx < 0) break
      const end = idx + e.folded.length
      let overlap = false
      for (let i = idx; i < end; i++) if (used[i]) { overlap = true; break }
      if (overlap) {
        from = idx + 1
        continue
      }
      for (let i = idx; i < end; i++) used[i] = true
      const rawStart = foldToRaw[idx]
      const rawEnd = foldToRaw[end - 1] + 1
      const fromSurface = text.slice(rawStart, rawEnd)
      inserts.push({ start: rawStart, end: rawEnd, to: e.canonical, from: fromSurface })
      from = end
    }
  }

  if (!inserts.length) return { text, replacements: [] }
  inserts.sort((a, b) => a.start - b.start)

  let out = ''
  let cursor = 0
  for (const ins of inserts) {
    out += text.slice(cursor, ins.start)
    out += ins.to
    replacements.push({ from: ins.from, to: ins.to })
    cursor = ins.end
  }
  out += text.slice(cursor)
  return { text: out, replacements }
}

const CN_DIGIT_RUN = String.raw`[零〇○洞一幺壹二两贰三四五六七八九十百千万\d]`

/**
 * 通用模式（词典未覆盖时的兜底）。
 * 顺序：多字母单号 → 单字母型号 → 客户编码 —— 避免 `s o 杠…` 被拆成 `o-…`
 */
function applyPatterns(text: string): { text: string; replacements: AsrReplacement[] } {
  const replacements: AsrReplacement[] = []
  let out = text

  // ① 单号 / 多段码：≥2 字母 + 杠 + 数字段（可重复）
  // 「s o 杠二零二六杠幺零零七」→ SO-2026-1007
  const orderRe = new RegExp(
    String.raw`\b([A-Za-z](?:\s*[A-Za-z])+)${SEP}((?:${CN_DIGIT_RUN}(?:\s*${CN_DIGIT_RUN})*)(?:${SEP}(?:${CN_DIGIT_RUN}(?:\s*${CN_DIGIT_RUN})*))*)`,
    'gi'
  )
  out = out.replace(orderRe, (full, lettersRaw: string, rest: string) => {
    const letters = lettersRaw.replace(/\s+/g, '').toUpperCase()
    const segs = rest.split(/\s*(?:杠|橫杠|横杠|破折号|-|—|－)\s*/)
    const nums: string[] = []
    for (const seg of segs) {
      const d = spokenDigitsToArabic(seg)
      if (!d) return full
      nums.push(d)
    }
    if (nums.length < 1) return full
    const canonical = [letters, ...nums].join('-')
    if (foldWs(full) === foldWs(canonical)) return full
    replacements.push({ from: full, to: canonical })
    return canonical
  })

  // ②a 型号 · 阿拉伯数字（不允许数字内空格，避免「A100 一百个」被吞成 A-100个）
  const modelArRe = new RegExp(
    String.raw`(?<![A-Za-z])([A-Za-z])(?:\s*(?:杠|橫杠|横杠|破折号|-|—|－)\s*)?(\d{2,})`,
    'g'
  )
  out = out.replace(modelArRe, (full, letter: string, digits: string) => {
    // 已是 A-100
    if (/^[A-Za-z]-\d+$/i.test(full.replace(/\s+/g, ''))) return full
    // 前导零 → 客户编码形态（C001），不插横杠
    if (/^0\d/.test(digits)) {
      const code = `${letter.toUpperCase()}${digits}`
      if (foldWs(full) === foldWs(code)) return full
      replacements.push({ from: full, to: code })
      return code
    }
    const canonical = `${letter.toUpperCase()}-${digits}`
    if (foldWs(full) === foldWs(canonical)) return full
    replacements.push({ from: full, to: canonical })
    return canonical
  })

  // ②b 型号 · 中文读法（a 杠一百 / a 一 零 零 / B两百）—— 数字段不含阿拉伯数字
  const modelCnRe = new RegExp(
    String.raw`(?<![A-Za-z])([A-Za-z])${SEP}?([零〇○洞一幺壹二两贰三四五六七八九十百千万](?:\s*[零〇○洞一幺壹二两贰三四五六七八九十百千万])*)`,
    'g'
  )
  out = out.replace(modelCnRe, (full, letter: string, numRaw: string) => {
    const digits = spokenDigitsToArabic(numRaw)
    if (!digits || digits.length < 2) return full
    // 前导零（零零一）→ 客户编码
    if (/^0\d/.test(digits)) {
      const code = `${letter.toUpperCase()}${digits}`
      if (foldWs(full) === foldWs(code)) return full
      replacements.push({ from: full, to: code })
      return code
    }
    const canonical = `${letter.toUpperCase()}-${digits}`
    if (foldWs(full) === foldWs(canonical)) return full
    replacements.push({ from: full, to: canonical })
    return canonical
  })

  return { text: out, replacements }
}

/**
 * 主入口：先词典（主数据反查），再通用模式兜底。
 * 幂等：对已是规范写法的句子再跑一遍，应 `changed: false`。
 */
export function normalizeAsrText(raw: string, dict: AsrNormalizeDict): AsrNormalizeResult {
  const input = raw ?? ''
  if (!input.trim()) {
    return { text: input, changed: false, replacements: [] }
  }

  const lex = buildLexicon(dict)
  const a = applyLexicon(input, lex)
  const b = applyPatterns(a.text)
  const replacements = [...a.replacements, ...b.replacements]
  const text = b.text
  return {
    text,
    changed: text !== input,
    replacements,
  }
}
