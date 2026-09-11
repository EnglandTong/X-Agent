import type { Verb } from './types'

export const inventoryReserve: Verb = {
  name: 'inventory.reserve',
  risk: 'write',

  async run(args, ctx) {
    const { db } = ctx
    const productId = String(args.productId)
    const warehouse = String(args.warehouseId)
    const qty = Number(args.qty)

    const inv = await db.inventory.findFirst({
      where: { productId, warehouse },
      include: { product: true },
    })
    if (!inv) return { ok: false, message: `仓库「${warehouse}」无该产品库存行。`, issues: [] }

    const available = inv.qty - inv.reserved
    if (qty > available) {
      return {
        ok: false,
        message: `可用库存不足：需要 ${qty}，可用 ${available}。`,
        issues: [],
      }
    }

    const updated = await db.inventory.update({
      where: { id: inv.id },
      data: { reserved: inv.reserved + qty },
      include: { product: true },
    })

    return {
      ok: true,
      data: {
        product: updated.product.model,
        warehouse,
        reservedDelta: qty,
        reserved: updated.reserved,
        available: updated.qty - updated.reserved,
      },
      message: `已预留 ${updated.product.model} @ ${warehouse} × ${qty}。`,
      issues: [],
    }
  },
}
