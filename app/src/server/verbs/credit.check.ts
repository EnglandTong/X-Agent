import type { Verb } from './types'

/** 与 order.create 共用同一套额度语义，避免两套规则。 */
export const creditCheck: Verb = {
  name: 'credit.check',
  risk: 'read',

  async run(args, ctx) {
    const { db } = ctx
    const customerId = String(args.customerId)
    const amount = Number(args.amount)

    const customer = await db.customer.findUnique({ where: { id: customerId } })
    if (!customer) return { ok: false, message: '客户不存在。', issues: [] }

    const remain = customer.creditLimit - customer.creditUsed
    const ok = amount <= remain

    return {
      ok: true,
      data: {
        customer: customer.name,
        code: customer.code,
        amount,
        creditLimit: customer.creditLimit,
        creditUsed: customer.creditUsed,
        available: remain,
        pass: ok,
      },
      message: ok
        ? `信用检查通过：拟下单 ¥${amount.toLocaleString('zh-CN')}，可用额度 ¥${remain.toLocaleString('zh-CN')}。`
        : `信用不足：拟下单 ¥${amount.toLocaleString('zh-CN')}，可用额度仅 ¥${remain.toLocaleString('zh-CN')}。`,
      issues: ok
        ? []
        : [
            {
              level: 'block' as const,
              rule: 'credit_limit',
              message: `超出可用额度 ¥${remain.toLocaleString('zh-CN')}`,
            },
          ],
    }
  },
}
