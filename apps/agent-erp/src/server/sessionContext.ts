/**
 * 会话感官焦点（G3-1）—— OCR/语音格挂当前客户，支持「就按上一张图」
 *
 * 内存态 + Panel 历史回落；不写真实业务表。
 */

import type { PrismaClient } from '@prisma/client'
import type { Modality } from '@x-agent/core/observation'
import type { SlotResult } from './agent'

export interface SensoryFocus {
  modality: Modality
  customerId: string
  customerLabel: string
  correlationId: string
  at: string
  /** 原 OCR/语音 原话片段，供 UI 展示 */
  sourceUtterance?: string
}

const focusBySession = new Map<string, SensoryFocus>()

/** 口语指代上一张图 / 上一段语音里的客户 */
const SENSORY_REF =
  /就按(上一张|刚才那张|上一张图|那个图)|跟(上一张|刚才)(图|单)?一样|还是(这个|刚才的?)?客户|同上|按(上一张|图|刚才)/

export function isSensoryContextRef(utterance: string): boolean {
  return SENSORY_REF.test(utterance.trim())
}

export function setSensoryFocus(sessionId: string, focus: SensoryFocus) {
  focusBySession.set(sessionId, focus)
}

export function getSensoryFocusMemory(sessionId: string): SensoryFocus | null {
  return focusBySession.get(sessionId) ?? null
}

/** 从已提交 Panel 回落（entities / correlationId） */
export async function loadSensoryFocusFromPanels(
  db: PrismaClient,
  sessionId: string
): Promise<SensoryFocus | null> {
  const rows = await db.panel.findMany({
    where: { sessionId },
    orderBy: { seq: 'desc' },
    take: 30,
    select: { correlationId: true, entities: true, utterance: true, createdAt: true },
  })

  for (const row of rows) {
    if (!row.entities) continue
    let entities: Array<{ type: string; value: string; label: string }> = []
    try {
      entities = JSON.parse(row.entities)
    } catch {
      continue
    }
    const cust = entities.find((e) => e.type === 'customer')
    if (!cust?.value) continue
    const cid = row.correlationId?.startsWith('CUS:')
      ? row.correlationId
      : `CUS:${cust.value}`
    return {
      modality: 'text',
      customerId: cust.value,
      customerLabel: cust.label,
      correlationId: cid,
      at: row.createdAt.toISOString(),
      sourceUtterance: row.utterance ?? undefined,
    }
  }
  return null
}

export async function getSensoryFocus(
  db: PrismaClient,
  sessionId: string
): Promise<SensoryFocus | null> {
  return getSensoryFocusMemory(sessionId) ?? loadSensoryFocusFromPanels(db, sessionId)
}

/** interpret 完成后，若感官入口且客户已消解，刷新焦点 */
export function updateSensoryFocusFromSlots(
  sessionId: string,
  modality: Modality,
  slots: SlotResult[],
  utterance?: string
) {
  if (modality === 'text') return
  const cust = slots.find((s) => s.slot === 'customer' && s.value)
  if (!cust?.value) return
  setSensoryFocus(sessionId, {
    modality,
    customerId: String(cust.value),
    customerLabel: cust.label ?? String(cust.raw ?? cust.value),
    correlationId: `CUS:${cust.value}`,
    at: new Date().toISOString(),
    sourceUtterance: utterance,
  })
}

/** 给规则抽取器用的客户名注入（仅当话术指代上一张且本句未提客户） */
export function customerInjectFromFocus(
  utterance: string,
  focus: SensoryFocus | null
): string | null {
  if (!focus || !isSensoryContextRef(utterance)) return null
  if (/给|客户是|客户[:：]/.test(utterance)) return null
  return focusCustomerName(focus)
}

function focusCustomerName(focus: SensoryFocus): string {
  return focus.customerLabel.replace(/（.*）$/, '').trim() || focus.customerLabel
}
