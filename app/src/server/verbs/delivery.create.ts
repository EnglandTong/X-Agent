import type { Verb } from './types'
import { remainingByProduct } from '../remaining'

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
    /** 可选：部分出货数量（单行订单时生效；多行则按比例不适用，仅限制首行） */
    const partialQty =
      args.qty !== undefined && args.qty !== null && args.qty !== ''
        ? Number(args.qty)
        : null

    const order = await db.order.findFirst({
      where: { no: orderNo },
      include: { items: true },
    })
    if (!order) return { ok: false, message: `订单 ${orderNo} 不存在。`, issues: [] }
    if (order.status !== 'CONFIRMED' && order.status !== 'PARTIALLY_SHIPPED') {
      return {
        ok: false,
        message: `订单 ${orderNo} 状态为 ${order.status}，只有已确认/部分出货订单可做出货单。`,
        issues: [],
      }
    }

    const remaining = await remainingByProduct(db, order.id)
    const lines: Array<{ productId: string; qty: number }> = []
    for (const it of order.items) {
      const rem = remaining.get(it.productId)?.remaining ?? 0
      if (rem <= 0) continue
      let qty = rem
      if (partialQty !== null && Number.isFinite(partialQty) && order.items.length === 1) {
        if (partialQty <= 0) {
          return { ok: false, message: '出货数量必须大于 0。', issues: [] }
        }
        if (partialQty > rem) {
          return {
            ok: false,
            message: `出货数量 ${partialQty} 超过剩余可出 ${rem}，禁止超量。`,
            issues: [],
          }
        }
        qty = partialQty
      }
      lines.push({ productId: it.productId, qty })
    }

    if (!lines.length) {
      return {
        ok: false,
        message: `订单 ${orderNo} 已无剩余可出货数量。`,
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
          create: lines,
        },
      },
      include: { items: { include: { product: true } }, order: true },
    })

    const remAfter = lines.map((l) => {
      const r = remaining.get(l.productId)!
      return { productId: l.productId, remainingAfter: r.remaining - l.qty }
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
        remaining: remAfter,
      },
      message: `已生成出货单 ${delivery.no}（草稿，按剩余量），确认后将扣减库存。`,
      issues: [],
    }
  },
}
