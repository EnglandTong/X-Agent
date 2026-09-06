import type { Verb } from './types'

export const deliveryConfirm: Verb = {
  name: 'delivery.confirm',
  risk: 'write',

  async run(args, ctx) {
    const { db } = ctx
    const deliveryNo = String(args.deliveryNo ?? '').trim()

    const delivery = await db.delivery.findFirst({
      where: { no: deliveryNo },
      include: { items: true, order: true },
    })
    if (!delivery) return { ok: false, message: `出货单 ${deliveryNo} 不存在。`, issues: [] }
    if (delivery.status !== 'DRAFT') {
      return { ok: false, message: `出货单 ${deliveryNo} 已确认，不可重复确认。`, issues: [] }
    }

    const warehouse = delivery.warehouse ?? delivery.order.warehouse
    if (!warehouse) {
      return { ok: false, message: '出货单缺少仓库，无法扣库存。', issues: [] }
    }

    // 预检库存
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
      await tx.order.update({
        where: { id: delivery.orderId },
        data: { status: 'SHIPPED' },
      })
    })

    return {
      ok: true,
      data: {
        deliveryNo: delivery.no,
        orderNo: delivery.order.no,
        status: 'CONFIRMED',
        warehouse,
      },
      message: `出货单 ${delivery.no} 已确认，库存已扣减，订单 ${delivery.order.no} 标记为已出货。`,
      issues: [],
    }
  },
}
