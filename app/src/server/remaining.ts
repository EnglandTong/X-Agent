/**
 * 订单行剩余可出货量（RFTS _remaining_by_line 思路）
 * 已确认出货单的 qty 合计占用；草稿出货单不占用（可删改）。
 */

import type { PrismaClient } from '@prisma/client'

export interface RemainingLine {
  productId: string
  ordered: number
  shipped: number
  remaining: number
}

export async function remainingByProduct(
  db: PrismaClient,
  orderId: string,
  /** 确认当前出货单时，排除自身（草稿尚未 CONFIRMED，本就不计入） */
  _excludeDeliveryId?: string
): Promise<Map<string, RemainingLine>> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      deliveries: {
        where: { status: 'CONFIRMED' },
        include: { items: true },
      },
    },
  })
  if (!order) return new Map()

  const shipped = new Map<string, number>()
  for (const d of order.deliveries) {
    for (const it of d.items) {
      shipped.set(it.productId, (shipped.get(it.productId) ?? 0) + it.qty)
    }
  }

  const map = new Map<string, RemainingLine>()
  for (const it of order.items) {
    const s = shipped.get(it.productId) ?? 0
    map.set(it.productId, {
      productId: it.productId,
      ordered: it.qty,
      shipped: s,
      remaining: Math.max(0, it.qty - s),
    })
  }
  return map
}

export function orderShipStatus(remaining: Map<string, RemainingLine>): 'SHIPPED' | 'PARTIALLY_SHIPPED' | 'CONFIRMED' {
  const lines = [...remaining.values()]
  if (!lines.length) return 'CONFIRMED'
  const allDone = lines.every((l) => l.remaining === 0)
  if (allDone) return 'SHIPPED'
  const anyShipped = lines.some((l) => l.shipped > 0)
  return anyShipped ? 'PARTIALLY_SHIPPED' : 'CONFIRMED'
}
