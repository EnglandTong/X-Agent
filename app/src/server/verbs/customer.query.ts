import type { Verb } from './types'

export const customerQuery: Verb = {
  name: 'customer.query',
  risk: 'read',

  async run(args, ctx) {
    const { db } = ctx
    const customerId = args.customerId as string | undefined
    const keyword = args.keyword ? String(args.keyword).trim() : ''

    const rows = await db.customer.findMany({
      where: customerId
        ? { id: customerId }
        : keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { code: { contains: keyword } },
              ],
            }
          : undefined,
      orderBy: { code: 'asc' },
      take: 50,
    })

    return {
      ok: true,
      data: {
        rows: rows.map((c: any) => ({
          code: c.code,
          name: c.name,
          level: c.level,
          creditLimit: c.creditLimit,
          creditUsed: c.creditUsed,
          available: c.creditLimit - c.creditUsed,
          lastWarehouse: c.lastWarehouse,
        })),
      },
      message: `共 ${rows.length} 位客户。`,
      issues: [],
    }
  },
}
