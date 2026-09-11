import type { Verb } from './types'
import { STATUS_LABEL } from '../resolve'

/**
 * order.query —— 只读动词，参数简单。
 * 这是 1.7B 小模型的主场（四象限中的「只读 × 简单参数」）。
 */
export const orderQuery: Verb = {
  name: 'order.query',
  risk: 'read',

  async run(args, ctx) {
    const { db } = ctx
    const customerId = args.customerId as string | undefined
    const status = args.status as string | undefined
    const keyword = args.keyword as string | undefined
    const limit = Math.min(Number(args.limit ?? 10) || 10, 100)

    const rows = await db.order.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        ...(status ? { status } : {}),
        ...(keyword ? { no: { contains: keyword } } : {}),
      },
      include: {
        customer: true,
        items: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    if (rows.length === 0) {
      return { ok: true, data: [], message: '没有符合条件的订单。' }
    }

    const data = rows.map((o) => ({
      no: o.no,
      customer: o.customer.name,
      status: STATUS_LABEL[o.status] ?? o.status,
      statusRaw: o.status,
      warehouse: o.warehouse ?? '—',
      // 关联信息：这张单从哪来、被谁取代 —— 变更链的可视化线索
      originNo: o.originNo,
      supersededByNo: o.supersededByNo,
      deliveryDate: o.deliveryDate
        ? o.deliveryDate.toISOString().slice(0, 10)
        : '—',
      amount: o.totalAmount,
      items: o.items.map((i) => ({
        model: i.product.model,
        name: i.product.name,
        qty: i.qty,
        unitPrice: i.unitPrice,
      })),
    }))

    const total = rows.reduce((s, o) => s + o.totalAmount, 0)
    return {
      ok: true,
      data,
      message: `查到 ${rows.length} 张订单，合计 ¥${total.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}。`,
    }
  },
}
