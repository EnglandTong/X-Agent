/**
 * 个人用语表 —— 习惯说法 → 动词 / 槽位目标
 * 精确优先 + 轻模糊（≥0.95）；不做向量检索。
 */

import type { PrismaClient } from '@prisma/client'

export type LexemeKind = 'verb' | 'slot'
export type LexemeSource = 'explicit' | 'confirmed'
export type LexemeStatus = 'active' | 'rejected' | 'retired'

export interface LexemeHit {
  id: string
  phrase: string
  kind: LexemeKind
  verb: string | null
  slot: string | null
  targetId: string | null
  targetLabel: string | null
  targetRaw: string | null
  confidence: number
  note: string
}

/** 与 resolve.norm 同思路，避免循环依赖故本地一份 */
export function phraseNorm(s: string): string {
  return s
    .replace(/[\s\-_．。]/g, '')
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .trim()
}

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

function similarity(query: string, target: string): number {
  const q = phraseNorm(query)
  const t = phraseNorm(target)
  if (!q || !t) return 0
  if (q === t) return 1
  if (t.includes(q)) return 0.9 + 0.1 * (q.length / t.length)
  if (q.includes(t)) return 0.85
  return Math.max(0, 1 - editDistance(q, t) / Math.max(q.length, t.length))
}

async function touchHit(db: PrismaClient, id: string) {
  await db.personalLexeme.update({
    where: { id },
    data: { hits: { increment: 1 }, lastUsedAt: new Date() },
  })
}

function toHit(
  row: {
    id: string
    phrase: string
    kind: string
    verb: string | null
    slot: string | null
    targetId: string | null
    targetLabel: string | null
    targetRaw: string | null
  },
  confidence: number
): LexemeHit {
  return {
    id: row.id,
    phrase: row.phrase,
    kind: row.kind as LexemeKind,
    verb: row.verb,
    slot: row.slot,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    targetRaw: row.targetRaw,
    confidence,
    note: `个人用语「${row.phrase}」`,
  }
}

/**
 * 在 utterance 中查找 kind=verb 的用语。
 * 优先：整句精确；其次：短语作为子串且 similarity≥0.95 / 精确 phraseNorm 子串。
 */
export async function lookupVerb(
  db: PrismaClient,
  utterance: string,
  userId = 'owner'
): Promise<LexemeHit | null> {
  const q = phraseNorm(utterance)
  if (!q) return null

  const rows = await db.personalLexeme.findMany({
    where: { userId, status: 'active', kind: 'verb' },
    orderBy: [{ hits: 'desc' }, { lastUsedAt: 'desc' }],
  })
  if (!rows.length) return null

  const exact = rows.filter((r) => r.phraseNorm === q)
  if (exact.length === 1) {
    await touchHit(db, exact[0].id)
    return toHit(exact[0], 0.98)
  }
  if (exact.length > 1) return null

  const scored = rows
    .map((r) => {
      const sim = similarity(utterance, r.phrase)
      const contained = q.includes(r.phraseNorm) && r.phraseNorm.length >= 2
      const score = Math.max(sim, contained ? 0.96 : 0)
      return { row: r, score }
    })
    .filter((x) => x.score >= 0.95)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.02) return null

  await touchHit(db, scored[0].row.id)
  return toHit(scored[0].row, scored[0].score)
}

/** 槽位 raw → kind=slot 用语 */
export async function lookupSlot(
  db: PrismaClient,
  raw: string,
  slot: string,
  userId = 'owner'
): Promise<LexemeHit | null> {
  const q = phraseNorm(raw)
  if (!q || q.length < 1) return null

  const rows = await db.personalLexeme.findMany({
    where: { userId, status: 'active', kind: 'slot', slot },
    orderBy: [{ hits: 'desc' }, { lastUsedAt: 'desc' }],
  })
  if (!rows.length) return null

  const exact = rows.filter((r) => r.phraseNorm === q)
  if (exact.length === 1) {
    await touchHit(db, exact[0].id)
    return toHit(exact[0], 0.98)
  }
  if (exact.length > 1) return null

  const scored = rows
    .map((r) => ({ row: r, score: similarity(raw, r.phrase) }))
    .filter((x) => x.score >= 0.95 && phraseNorm(x.row.phrase).length >= 2)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.02) return null

  await touchHit(db, scored[0].row.id)
  return toHit(scored[0].row, scored[0].score)
}

export interface UpsertLexemeInput {
  userId?: string
  phrase: string
  kind: LexemeKind
  verb?: string | null
  slot?: string | null
  targetId?: string | null
  targetLabel?: string | null
  targetRaw?: string | null
  source: LexemeSource
}

export async function upsertLexeme(db: PrismaClient, input: UpsertLexemeInput & { status?: LexemeStatus }) {
  const userId = input.userId ?? 'owner'
  const phrase = input.phrase.trim()
  const pn = phraseNorm(phrase)
  if (!pn) throw new Error('phrase 不能为空')
  if (input.kind === 'verb' && !input.verb && input.status !== 'rejected') {
    throw new Error('kind=verb 需要 verb')
  }
  if (input.kind === 'slot' && !input.slot) throw new Error('kind=slot 需要 slot')

  const slotKey = input.kind === 'slot' ? input.slot! : ''
  const status = input.status ?? 'active'

  return db.personalLexeme.upsert({
    where: {
      userId_phraseNorm_kind_slot: {
        userId,
        phraseNorm: pn,
        kind: input.kind,
        slot: slotKey,
      },
    },
    create: {
      userId,
      phrase,
      phraseNorm: pn,
      kind: input.kind,
      verb: input.kind === 'verb' ? input.verb ?? null : null,
      slot: slotKey,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      targetRaw: input.targetRaw ?? null,
      source: input.source,
      status,
    },
    update: {
      phrase,
      verb: input.kind === 'verb' ? input.verb ?? null : null,
      slot: slotKey,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      targetRaw: input.targetRaw ?? null,
      source: input.source,
      status,
    },
  })
}

export async function listLexemes(db: PrismaClient, userId = 'owner', status?: LexemeStatus) {
  return db.personalLexeme.findMany({
    where: { userId, ...(status ? { status } : {}) },
    orderBy: [{ hits: 'desc' }, { updatedAt: 'desc' }],
  })
}

export async function rejectLexeme(db: PrismaClient, id: string) {
  return db.personalLexeme.update({
    where: { id },
    data: { status: 'rejected' },
  })
}

export async function retireLexeme(db: PrismaClient, id: string) {
  return db.personalLexeme.update({
    where: { id },
    data: { status: 'retired' },
  })
}

/** 目标是否仍存在于主数据；失效则标记 retired */
export async function validateSlotTarget(
  db: PrismaClient,
  hit: LexemeHit
): Promise<boolean> {
  if (!hit.targetId) return false
  if (hit.slot === 'customer') {
    const c = await db.customer.findUnique({ where: { id: hit.targetId } })
    if (!c) {
      await retireLexeme(db, hit.id)
      return false
    }
    return true
  }
  if (hit.slot === 'product') {
    const p = await db.product.findUnique({ where: { id: hit.targetId } })
    if (!p) {
      await retireLexeme(db, hit.id)
      return false
    }
    return true
  }
  // warehouse / enum：targetId 即枚举值本身
  return true
}

/** 根据确认结果生成「是否记住」提议（不入库）；过滤已 rejected 的说法 */
export async function proposeFromConfirm(
  db: PrismaClient,
  opts: {
    utterance: string
    verb: string
    slots: Array<{
      slot: string
      field: string
      raw: unknown
      value: unknown
      label?: string
      candidates?: unknown[]
    }>
    submittedValues: Record<string, unknown>
    userId?: string
  }
): Promise<
  Array<{
    phrase: string
    kind: LexemeKind
    verb?: string
    slot?: string
    targetId?: string
    targetLabel?: string
    targetRaw?: string
  }>
> {
  const userId = opts.userId ?? 'owner'
  const rejected = await db.personalLexeme.findMany({
    where: { userId, status: 'rejected' },
    select: { phraseNorm: true, kind: true, slot: true },
  })
  const rejectedSet = new Set(rejected.map((r) => `${r.kind}|${r.slot}|${r.phraseNorm}`))

  const out: Array<{
    phrase: string
    kind: LexemeKind
    verb?: string
    slot?: string
    targetId?: string
    targetLabel?: string
    targetRaw?: string
  }> = []

  for (const s of opts.slots) {
    if (s.slot !== 'customer' && s.slot !== 'product') continue
    const finalVal = opts.submittedValues[s.field] ?? s.value
    if (finalVal == null || finalVal === '') continue

    const changed = s.value != null && String(s.value) !== String(finalVal)
    const resolvedAmbiguity = Boolean(s.candidates?.length) && finalVal != null
    const hasRaw =
      s.raw != null && String(s.raw).trim() !== '' && phraseNorm(String(s.raw)).length >= 2

    if (!(changed || resolvedAmbiguity) || !hasRaw) continue

    const phrase = String(s.raw).trim()
    const key = `slot|${s.slot}|${phraseNorm(phrase)}`
    if (rejectedSet.has(key)) continue

    out.push({
      phrase,
      kind: 'slot',
      slot: s.slot,
      targetId: String(finalVal),
      targetLabel: s.label ?? String(finalVal),
      targetRaw: String(s.raw),
    })
  }

  return out
}
