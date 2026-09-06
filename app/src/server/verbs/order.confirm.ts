import type { Verb } from './types'
import { STATUS_LABEL } from '../resolve'

/**
 * order.confirm —— 确认订单
 *
 * 这是整条链上最关键的一道门槛：**确认之前，单可以改；确认之后，单冻住。**
 * 有了这道门槛，「改单 = 另开一张新单」才成立 ——
 * 否则所有单永远停留在草稿态，变更单机制形同虚设。
 */
export const orderConfirm: Verb = {
  name: 'order.confirm',
  risk: 'write',

  async run(args, ctx) {
    const { db } = ctx
    const no = String(args.orderNo ?? '').trim()

    const order = await db.order.findFirst({ where: { no } })
    if (!order) {
      return { ok: false, message: `订单 ${no} 不存在。`, issues: [] }
    }
    if (order.status !== 'DRAFT') {
      return {
        ok: false,
        message: `订单 ${no} 当前状态为「${STATUS_LABEL[order.status] ?? order.status}」，只有草稿可以确认。`,
        issues: [],
      }
    }

    const updated = await db.order.update({
      where: { id: order.id },
      data: { status: 'CONFIRMED' },
      include: { customer: true },
    })

    return {
      ok: true,
      data: {
        no: updated.no,
        status: STATUS_LABEL.CONFIRMED,
        statusRaw: updated.status,
        amount: updated.totalAmount,
        customer: updated.customer.name,
      },
      message: `订单 ${updated.no} 已确认。此后不可再修改，如需调整请另开变更单。`,
      issues: [],
    }
  },
}
