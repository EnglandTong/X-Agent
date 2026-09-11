/**
 * 企业标准别名（B 层）—— 公司维护，审核后才 active（决策 #30）
 */

import type { PrismaClient } from '@prisma/client'
import { phraseNorm } from './lexicon'

export type EntityKind = 'customer' | 'product' | 'warehouse'
export type AliasStatus = 'candidate' | 'active' | 'rejected' | 'retired'

export interface EnterpriseAliasHit {
  id: string
  alias: string
  entityKind: EntityKind
  entityId: string
  label: string
  confidence: number
  note: string
}

const WAREHOUSES = new Set(['华东仓', '华南仓', '华北仓'])

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
  await db.enterpriseAlias.update({
    where: { id },
    data: { hits: { increment: 1 }, lastUsedAt: new Date() },
  })
}

async function labelFor(
  db: PrismaClient,
  entityKind: EntityKind,
  entityId: string
): Promise<string | null> {
  if (entityKind === 'customer') {
    const c = await db.customer.findUnique({ where: { id: entityId } })
    return c ? `${c.name}（${c.code}）` : null
  }
  if (entityKind === 'product') {
    const p = await db.product.findUnique({ where: { id: entityId } })
    return p ? `${p.model} ${p.name}` : null
  }
  if (entityKind === 'warehouse') {
    return WAREHOUSES.has(entityId) ? entityId : null
  }
  return null
}

/** 仅 status=active；精确 aliasNorm 优先，轻模糊 ≥0.95 */
export async function lookupEnterpriseAlias(
  db: PrismaClient,
  raw: string,
  entityKind: EntityKind
): Promise<EnterpriseAliasHit | null> {
  const q = phraseNorm(raw)
  if (!q || q.length < 2) return null

  const rows = await db.enterpriseAlias.findMany({
    where: { entityKind, status: 'active' },
    orderBy: [{ hits: 'desc' }, { lastUsedAt: 'desc' }],
  })
  if (!rows.length) return null

  const exact = rows.filter((r) => r.aliasNorm === q)
  if (exact.length === 1) {
    const label = (await labelFor(db, entityKind, exact[0].entityId)) ?? exact[0].entityId
    await touchHit(db, exact[0].id)
    return {
      id: exact[0].id,
      alias: exact[0].alias,
      entityKind,
      entityId: exact[0].entityId,
      label,
      confidence: 0.97,
      note: `企业别名「${exact[0].alias}」`,
    }
  }
  if (exact.length > 1) return null

  const scored = rows
    .map((r) => ({ row: r, score: similarity(raw, r.alias) }))
    .filter((x) => x.score >= 0.95 && phraseNorm(x.row.alias).length >= 2)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.02) return null

  const row = scored[0].row
  const label = (await labelFor(db, entityKind, row.entityId)) ?? row.entityId
  if (!label) {
    await retireEnterpriseAlias(db, row.id)
    return null
  }

  await touchHit(db, row.id)
  return {
    id: row.id,
    alias: row.alias,
    entityKind,
    entityId: row.entityId,
    label,
    confidence: scored[0].score,
    note: `企业别名「${row.alias}」`,
  }
}

export async function validateEnterpriseTarget(
  db: PrismaClient,
  hit: EnterpriseAliasHit
): Promise<boolean> {
  const label = await labelFor(db, hit.entityKind, hit.entityId)
  if (!label) {
    await retireEnterpriseAlias(db, hit.id)
    return false
  }
  return true
}

export interface UpsertEnterpriseAliasInput {
  entityKind: EntityKind
  entityId: string
  alias: string
  source?: string
  note?: string
  status?: AliasStatus
  approvedBy?: string
}

export async function upsertEnterpriseAlias(db: PrismaClient, input: UpsertEnterpriseAliasInput) {
  const alias = input.alias.trim()
  const pn = phraseNorm(alias)
  if (!pn) throw new Error('alias 不能为空')

  const label = await labelFor(db, input.entityKind, input.entityId)
  if (!label) throw new Error('entityId 无效或实体不存在')

  const status = input.status ?? 'candidate'
  const approvedAt = status === 'active' ? new Date() : null

  return db.enterpriseAlias.upsert({
    where: { entityKind_aliasNorm: { entityKind: input.entityKind, aliasNorm: pn } },
    create: {
      entityKind: input.entityKind,
      entityId: input.entityId,
      alias,
      aliasNorm: pn,
      source: input.source ?? 'import',
      note: input.note ?? null,
      status,
      approvedBy: input.approvedBy ?? null,
      approvedAt,
    },
    update: {
      entityId: input.entityId,
      alias,
      source: input.source ?? 'import',
      note: input.note ?? null,
      ...(input.status ? { status, approvedBy: input.approvedBy ?? null, approvedAt } : {}),
    },
  })
}

export async function listEnterpriseAliases(
  db: PrismaClient,
  opts: { status?: AliasStatus; entityKind?: EntityKind } = {}
) {
  return db.enterpriseAlias.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.entityKind ? { entityKind: opts.entityKind } : {}),
    },
    orderBy: [{ status: 'asc' }, { hits: 'desc' }, { updatedAt: 'desc' }],
  })
}

export async function approveEnterpriseAlias(db: PrismaClient, id: string, approvedBy = 'owner') {
  return db.enterpriseAlias.update({
    where: { id },
    data: { status: 'active', approvedBy, approvedAt: new Date() },
  })
}

export async function rejectEnterpriseAlias(db: PrismaClient, id: string) {
  return db.enterpriseAlias.update({
    where: { id },
    data: { status: 'rejected' },
  })
}

export async function retireEnterpriseAlias(db: PrismaClient, id: string) {
  return db.enterpriseAlias.update({
    where: { id },
    data: { status: 'retired' },
  })
}

/** CSV 行：entityKind,alias,entityIdOrCode,source,status(optional) */
export async function importEnterpriseAliasesCsv(
  db: PrismaClient,
  csvText: string,
  opts: { defaultStatus?: AliasStatus; approvedBy?: string } = {}
) {
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean)
  const results: Array<{ alias: string; ok: boolean; error?: string }> = []

  for (const line of lines) {
    if (line.startsWith('#') || line.toLowerCase().startsWith('entitykind')) continue
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 3) {
      results.push({ alias: line, ok: false, error: '列数不足' })
      continue
    }
    const [entityKind, alias, ref, source = 'import', statusRaw] = parts
    if (!['customer', 'product', 'warehouse'].includes(entityKind)) {
      results.push({ alias, ok: false, error: 'entityKind 无效' })
      continue
    }

    let entityId = ref
    try {
      if (entityKind === 'customer') {
        const c =
          (await db.customer.findUnique({ where: { id: ref } })) ??
          (await db.customer.findFirst({ where: { code: ref } }))
        if (!c) throw new Error('客户不存在')
        entityId = c.id
      } else if (entityKind === 'product') {
        const p =
          (await db.product.findUnique({ where: { id: ref } })) ??
          (await db.product.findFirst({ where: { model: ref } }))
        if (!p) throw new Error('产品不存在')
        entityId = p.id
      } else if (!WAREHOUSES.has(ref)) {
        throw new Error('仓库名无效')
      }

      const status = (statusRaw as AliasStatus) || opts.defaultStatus || 'candidate'
      await upsertEnterpriseAlias(db, {
        entityKind: entityKind as EntityKind,
        entityId,
        alias,
        source,
        status,
        approvedBy: status === 'active' ? opts.approvedBy ?? 'import' : undefined,
      })
      results.push({ alias, ok: true })
    } catch (e) {
      results.push({ alias, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return results
}
