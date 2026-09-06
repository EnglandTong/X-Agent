import type { Verb } from './types'
import { STATUS_LABEL } from '../resolve'

export const orderCancel: Verb = {
  name: 'order.cancel',
  risk: 'write',

  async run(args, ctx) {
    const { db } = ctx
    const no = String(args.orderNo ?? '').trim()
    const reason = String(args.reason ?? '').trim()
    if (!reason) {
      return { ok: false, message: '取消原因不能为空。', issues: [] }
    }

    const order = await db.order.findFirst({ where: { no } })
    if (!order) return { ok: false, message: `订单 ${no} 不存在。`, issues: [] }

    if (order.status === 'SHIPPED') {
      return { ok: false, message: `订单 ${no} 已出货，不可取消。`, issues: [] }
    }
    if (order.status === 'CANCELLED') {
      return { ok: false, message: `订单 ${no} 已取消。`, issues: [] }
    }
    if (order.status === 'SUPERSEDED') {
      return { ok: false, message: `订单 ${no} 已被变更单取代，不可取消。`, issues: [] }
    }
    if (order.status !== 'DRAFT' && order.status !== 'CONFIRMED') {
      return {
        ok: false,
        message: `订单 ${no} 状态为「${STATUS_LABEL[order.status] ?? order.status}」，不可取消。`,
        issues: [],
      }
    }

    const updated = await db.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelReason: reason, remark: order.remark },
      include: { customer: true },
    })

    return {
      ok: true,
      data: {
        no: updated.no,
        status: STATUS_LABEL.CANCELLED ?? '已取消',
        statusRaw: updated.status,
        reason,
        customer: updated.customer.name,
      },
      message: `订单 ${updated.no} 已取消。原因：${reason}`,
      issues: [],
    }
  },
}
