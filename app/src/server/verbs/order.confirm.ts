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

    const customer = await db.customer.findUnique({ where: { id: order.customerId } })
    if (!customer) {
      return { ok: false, message: '客户不存在（可能已被删除）。', issues: [] }
    }

    // 仅 CONFIRMED 占用额度：确认时检查并写入 creditUsed
    const remain = customer.creditLimit - customer.creditUsed
    if (order.totalAmount > remain) {
      return {
        ok: false,
        message: `订单 ${no} 确认失败：金额 ¥${order.totalAmount.toLocaleString('zh-CN')} 超出可用额度 ¥${remain.toLocaleString('zh-CN')}。`,
        issues: [
          {
            level: 'block',
            rule: 'credit_limit',
            message: `订单金额 ¥${order.totalAmount.toLocaleString('zh-CN')} 超出可用额度 ¥${remain.toLocaleString('zh-CN')}（总额度 ¥${customer.creditLimit.toLocaleString('zh-CN')}，已用 ¥${customer.creditUsed.toLocaleString('zh-CN')}）`,
          },
        ],
      }
    }

    const updated = await db.$transaction(async (tx: any) => {
      const o = await tx.order.update({
        where: { id: order.id },
        data: { status: 'CONFIRMED' },
        include: { customer: true },
      })
      await tx.customer.update({
        where: { id: order.customerId },
        data: { creditUsed: { increment: order.totalAmount } },
      })
      return o
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
      message: `订单 ${updated.no} 已确认（已占用信用额度）。此后不可再修改，如需调整请另开变更单。`,
      issues: [],
    }
  },
}
