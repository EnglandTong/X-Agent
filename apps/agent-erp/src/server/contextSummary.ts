/**
 * 只读业务摘要（G3-2）—— interpret 后一行信用/库存，确认卡展示来源
 */

import type { PrismaClient } from '@prisma/client'
import type { SlotResult } from './agent'

export interface ContextSummaryLine {
  kind: 'credit' | 'inventory'
  text: string
  source: string
}

export interface ContextSummary {
  lines: ContextSummaryLine[]
}

export async function buildContextSummary(
  db: PrismaClient,
  slots: SlotResult[]
): Promise<ContextSummary> {
  const lines: ContextSummaryLine[] = []

  const custSlot = slots.find((s) => s.slot === 'customer' && s.value)
  if (custSlot?.value) {
    const c = await db.customer.findUnique({ where: { id: String(custSlot.value) } })
    if (c) {
      const remain = c.creditLimit - c.creditUsed
      lines.push({
        kind: 'credit',
        text: `${c.name}：可用信用 ¥${remain.toLocaleString('zh-CN')}（额度 ¥${c.creditLimit.toLocaleString('zh-CN')}，已用 ¥${c.creditUsed.toLocaleString('zh-CN')}）`,
        source: 'customer.creditLimit',
      })
    }
  }

  const prodSlot = slots.find((s) => s.slot === 'product' && s.value)
  const whSlot = slots.find((s) => s.slot === 'warehouse' && s.value)
  if (prodSlot?.value) {
    const inv = await db.inventory.findFirst({
      where: {
        productId: String(prodSlot.value),
        ...(whSlot?.value ? { warehouse: String(whSlot.value) } : {}),
      },
      include: { product: { select: { model: true } } },
      orderBy: whSlot?.value ? undefined : { qty: 'desc' },
    })
    if (inv) {
      const avail = inv.qty - inv.reserved
      lines.push({
        kind: 'inventory',
        text: `${inv.product.model} @ ${inv.warehouse}：可售 ${avail}（在库 ${inv.qty}，预留 ${inv.reserved}）`,
        source: 'inventory.qty',
      })
    }
  }

  return { lines: lines.slice(0, 2) }
}
