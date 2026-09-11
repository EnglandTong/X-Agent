import type { Verb } from './types'

export const deliveryQuery: Verb = {
  name: 'delivery.query',
  risk: 'read',

  async run(args, ctx) {
    const { db } = ctx
    const orderNo = args.orderNo ? String(args.orderNo).trim() : ''
    const keyword = args.keyword ? String(args.keyword).trim() : ''
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 10)))

    const where: any = {}
    if (orderNo) {
      const order = await db.order.findFirst({ where: { no: orderNo } })
      if (!order) return { ok: true, data: { rows: [] }, message: `订单 ${orderNo} 不存在。`, issues: [] }
      where.orderId = order.id
    }
    if (keyword) where.no = { contains: keyword }

    const rows = await db.delivery.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { order: true, items: { include: { product: true } } },
    })

    return {
      ok: true,
      data: {
        rows: rows.map((d: any) => ({
          deliveryNo: d.no,
          orderNo: d.order.no,
          status: d.status,
          warehouse: d.warehouse,
          lines: d.items.map((i: any) => `${i.product.model}×${i.qty}`).join('、'),
        })),
      },
      message: `共 ${rows.length} 条出货记录。`,
      issues: [],
    }
  },
}
