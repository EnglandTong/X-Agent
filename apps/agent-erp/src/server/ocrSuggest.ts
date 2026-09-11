/**
 * OCR 解析结果 → 企业别名 candidate（G2-3）
 *
 * 红线：只写 candidate，禁止自动 active。
 */

import type { PrismaClient } from '@prisma/client'
import { upsertEnterpriseAlias, lookupEnterpriseAlias, type EntityKind } from './enterpriseAlias'
import { parseWechatOrderText, suggestAliasPhrases, type WechatOrderFields } from './ocrWechat'

export interface OcrAliasSuggestion {
  phrase: string
  entityKind: EntityKind
  entityId: string
  label: string
  aliasId: string
}

async function fuzzyCustomer(db: PrismaClient, phrase: string) {
  const q = phrase.trim()
  const exact = await db.customer.findFirst({ where: { OR: [{ name: q }, { code: q }] } })
  if (exact) return exact
  const all = await db.customer.findMany()
  return all.find((c) => c.name.includes(q) || q.includes(c.name)) ?? null
}

async function fuzzyProduct(db: PrismaClient, phrase: string) {
  const q = phrase.trim().replace(/\s/g, '').toUpperCase()
  const exact = await db.product.findFirst({
    where: { OR: [{ model: q }, { name: phrase.trim() }] },
  })
  if (exact) return exact
  const model = phrase.match(/([A-Za-z]\s*-?\s*\d{3})/)
  if (model) {
    const m = model[1].replace(/\s/g, '').toUpperCase()
    return db.product.findFirst({ where: { model: m } })
  }
  return db.product.findFirst({ where: { name: { contains: phrase.trim() } } })
}

/** 把 OCR 字段里能对上主数据的说法写成 candidate 别名 */
export async function recordOcrAliasCandidates(
  db: PrismaClient,
  ocrText: string,
  fields?: WechatOrderFields
): Promise<OcrAliasSuggestion[]> {
  const parsed = fields ?? parseWechatOrderText(ocrText)
  const phrases = suggestAliasPhrases(parsed, ocrText)
  const out: OcrAliasSuggestion[] = []

  for (const { phrase, slot } of phrases) {
    const entityKind: EntityKind =
      slot === 'customer' ? 'customer' : slot === 'product' ? 'product' : 'warehouse'

    // 已是 active 企业别名则跳过
    const existing = await lookupEnterpriseAlias(db, phrase, entityKind)
    if (existing) continue

    let entityId: string | null = null
    let label = ''

    if (slot === 'customer') {
      const c = await fuzzyCustomer(db, phrase)
      if (!c) continue
      if (c.name === phrase || c.code === phrase) continue
      entityId = c.id
      label = `${c.name}（${c.code}）`
    } else if (slot === 'product') {
      const p = await fuzzyProduct(db, phrase)
      if (!p) continue
      if (p.model === phrase.replace(/\s/g, '').toUpperCase()) continue
      entityId = p.id
      label = `${p.model} ${p.name}`
    } else {
      const w = ['华东仓', '华南仓', '华北仓'].find((x) => phrase.includes(x.replace('仓', '')) || x === phrase)
      if (!w || w === phrase) continue
      entityId = w
      label = w
    }

    const row = await upsertEnterpriseAlias(db, {
      entityKind,
      entityId,
      alias: phrase,
      source: 'ocr_suggest',
      status: 'candidate',
      note: 'OCR 微信订单截图建议',
    })
    out.push({ phrase, entityKind, entityId, label, aliasId: row.id })
  }

  return out
}
