import type { Verb } from './types'

export const inventoryRelease: Verb = {
  name: 'inventory.release',
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
    if (qty > inv.reserved) {
      return {
        ok: false,
        message: `预留不足：要释放 ${qty}，当前预留 ${inv.reserved}。`,
        issues: [],
      }
    }

    const updated = await db.inventory.update({
      where: { id: inv.id },
      data: { reserved: inv.reserved - qty },
      include: { product: true },
    })

    return {
      ok: true,
      data: {
        product: updated.product.model,
        warehouse,
        released: qty,
        reserved: updated.reserved,
        available: updated.qty - updated.reserved,
      },
      message: `已释放 ${updated.product.model} @ ${warehouse} × ${qty}。`,
      issues: [],
    }
  },
}
