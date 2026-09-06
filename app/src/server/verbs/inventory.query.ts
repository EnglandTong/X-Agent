import type { Verb } from './types'

export const inventoryQuery: Verb = {
  name: 'inventory.query',
  risk: 'read',

  async run(args, ctx) {
    const { db } = ctx
    const productId = args.productId as string | undefined
    const warehouse = args.warehouseId as string | undefined

    const rows = await db.inventory.findMany({
      where: {
        ...(productId ? { productId } : {}),
        ...(warehouse ? { warehouse } : {}),
      },
      include: { product: true },
      orderBy: [{ warehouse: 'asc' }, { product: { model: 'asc' } }],
    })

    return {
      ok: true,
      data: {
        rows: rows.map((r: any) => ({
          product: r.product.model,
          name: r.product.name,
          warehouse: r.warehouse,
          qty: r.qty,
          reserved: r.reserved,
          available: r.qty - r.reserved,
        })),
      },
      message: `共 ${rows.length} 条库存记录。`,
      issues: [],
    }
  },
}
