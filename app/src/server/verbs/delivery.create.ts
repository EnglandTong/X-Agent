import type { Verb } from './types'

async function nextDeliveryNo(db: any) {
  const last = await db.delivery.findFirst({ orderBy: { createdAt: 'desc' } })
  const n = last?.no?.match(/(\d+)$/)?.[1]
  const next = n ? Number(n) + 1 : 1001
  return `DN-2026-${next}`
}

export const deliveryCreate: Verb = {
  name: 'delivery.create',
  risk: 'write',

  async run(args, ctx) {
    const { db, actor } = ctx
    const orderNo = String(args.orderNo ?? '').trim()
    const warehouse = (args.warehouseId as string | undefined) ?? null
    const remark = (args.remark as string | undefined) ?? null

    const order = await db.order.findFirst({
      where: { no: orderNo },
      include: { items: true },
    })
    if (!order) return { ok: false, message: `订单 ${orderNo} 不存在。`, issues: [] }
    if (order.status !== 'CONFIRMED') {
      return {
        ok: false,
        message: `订单 ${orderNo} 状态为 ${order.status}，只有已确认订单可做出货单。`,
        issues: [],
      }
    }

    const no = await nextDeliveryNo(db)
    const delivery = await db.delivery.create({
      data: {
        no,
        orderId: order.id,
        warehouse: warehouse ?? order.warehouse,
        status: 'DRAFT',
        remark,
        createdBy: actor,
        items: {
          create: order.items.map((it: any) => ({
            productId: it.productId,
            qty: it.qty,
          })),
        },
      },
      include: { items: { include: { product: true } }, order: true },
    })

    return {
      ok: true,
      data: {
        deliveryNo: delivery.no,
        orderNo: order.no,
        status: 'DRAFT',
        warehouse: delivery.warehouse,
        lines: delivery.items.map((i: any) => ({
          product: i.product.model,
          qty: i.qty,
        })),
      },
      message: `已生成出货单 ${delivery.no}（草稿），确认后将扣减库存。`,
      issues: [],
    }
  },
}
