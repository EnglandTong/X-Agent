import type { Verb } from './types'
import { remainingByProduct, orderShipStatus } from '../remaining'

export const deliveryConfirm: Verb = {
  name: 'delivery.confirm',
  risk: 'write',

  async run(args, ctx) {
    const { db } = ctx
    const deliveryNo = String(args.deliveryNo ?? '').trim()

    const delivery = await db.delivery.findFirst({
      where: { no: deliveryNo },
      include: { items: { include: { product: true } }, order: true },
    })
    if (!delivery) return { ok: false, message: `出货单 ${deliveryNo} 不存在。`, issues: [] }
    if (delivery.status !== 'DRAFT') {
      return { ok: false, message: `出货单 ${deliveryNo} 已确认，不可重复确认。`, issues: [] }
    }

    if (delivery.order.status !== 'CONFIRMED' && delivery.order.status !== 'PARTIALLY_SHIPPED') {
      return {
        ok: false,
        message: `订单 ${delivery.order.no} 状态为 ${delivery.order.status}，无法确认出货。`,
        issues: [],
      }
    }

    const warehouse = delivery.warehouse ?? delivery.order.warehouse
    if (!warehouse) {
      return { ok: false, message: '出货单缺少仓库，无法扣库存。', issues: [] }
    }

    // 剩余量硬拦（禁止超量）
    const remaining = await remainingByProduct(db, delivery.orderId)
    for (const item of delivery.items) {
      const rem = remaining.get(item.productId)?.remaining ?? 0
      if (item.qty > rem) {
        return {
          ok: false,
          message: `「${item.product.model}」出货 ${item.qty} 超过剩余可出 ${rem}，禁止超量。`,
          issues: [],
        }
      }
    }

    // 预检库存
    const stockWarnings: string[] = []
    for (const item of delivery.items) {
      const inv = await db.inventory.findFirst({
        where: { productId: item.productId, warehouse },
      })
      const avail = (inv?.qty ?? 0) - (inv?.reserved ?? 0)
      if (!inv || avail < item.qty) {
        return {
          ok: false,
          message: `仓库「${warehouse}」可用库存不足（需要 ${item.qty}，可用 ${Math.max(0, avail)}）。`,
          issues: [],
        }
      }
      // 可用性警告：可用但偏低（≤ 出货量的 1.2 倍）
      if (avail <= item.qty * 1.2) {
        stockWarnings.push(
          `「${item.product.model}」确认后可用约 ${avail - item.qty}（偏低）`
        )
      }
    }

    await db.$transaction(async (tx: any) => {
      for (const item of delivery.items) {
        const inv = await tx.inventory.findFirst({
          where: { productId: item.productId, warehouse },
        })
        await tx.inventory.update({
          where: { id: inv!.id },
          data: { qty: inv!.qty - item.qty },
        })
      }
      await tx.delivery.update({
        where: { id: delivery.id },
        data: { status: 'CONFIRMED' },
      })

      const after = await remainingByProduct(tx, delivery.orderId)
      const nextStatus = orderShipStatus(after)
      await tx.order.update({
        where: { id: delivery.orderId },
        data: { status: nextStatus },
      })
    })

    const afterMap = await remainingByProduct(db, delivery.orderId)
    const finalStatus = orderShipStatus(afterMap)

    return {
      ok: true,
      data: {
        deliveryNo: delivery.no,
        orderNo: delivery.order.no,
        status: 'CONFIRMED',
        orderStatus: finalStatus,
        warehouse,
        remaining: [...afterMap.values()].map((l) => ({
          productId: l.productId,
          remaining: l.remaining,
        })),
      },
      message: `出货单 ${delivery.no} 已确认，库存已扣减，订单 ${delivery.order.no} → ${finalStatus === 'SHIPPED' ? '已出货' : '部分出货'}。`,
      issues: stockWarnings.map((m) => ({
        level: 'warn' as const,
        rule: 'stock_low',
        message: m,
      })),
    }
  },
}
