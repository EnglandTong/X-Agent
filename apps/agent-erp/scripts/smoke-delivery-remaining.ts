/**
 * 出货剩余量冒烟：部分出货 → 再出货 → 超量应拦
 *   npx tsx scripts/smoke-delivery-remaining.ts
 */
import { PrismaClient } from '@prisma/client'
import { deliveryCreate } from '../src/server/verbs/delivery.create'
import { deliveryConfirm } from '../src/server/verbs/delivery.confirm'

async function main() {
  const db = new PrismaClient()
  const customer = await db.customer.findFirst({ where: { name: '张三' } })
  const product = await db.product.findFirst({ where: { model: 'A-100' } })
  if (!customer || !product) throw new Error('need seed')

  const no = `SO-SMOKE-${Date.now().toString(36)}`
  const order = await db.order.create({
    data: {
      no,
      customerId: customer.id,
      warehouse: '华东仓',
      status: 'CONFIRMED',
      totalAmount: 100,
      items: { create: [{ productId: product.id, qty: 100, unitPrice: 1, amount: 100 }] },
    },
  })

  // 确保库存够
  await db.inventory.upsert({
    where: { productId_warehouse: { productId: product.id, warehouse: '华东仓' } },
    create: { productId: product.id, warehouse: '华东仓', qty: 500, reserved: 0 },
    update: { qty: 500 },
  })

  const ctx = { db, actor: 'owner' }
  const d1 = await deliveryCreate.run({ orderNo: no, qty: 40 }, ctx)
  if (!d1.ok) throw new Error('d1 create fail: ' + d1.message)
  const dn1 = (d1.data as any).deliveryNo
  const c1 = await deliveryConfirm.run({ deliveryNo: dn1 }, ctx)
  if (!c1.ok) throw new Error('c1 fail: ' + c1.message)

  const ord1 = await db.order.findUnique({ where: { id: order.id } })
  if (ord1?.status !== 'PARTIALLY_SHIPPED') {
    throw new Error(`expected PARTIALLY_SHIPPED got ${ord1?.status}`)
  }

  const d2 = await deliveryCreate.run({ orderNo: no, qty: 40 }, ctx)
  if (!d2.ok) throw new Error('d2 create fail: ' + d2.message)
  const c2 = await deliveryConfirm.run({ deliveryNo: (d2.data as any).deliveryNo }, ctx)
  if (!c2.ok) throw new Error('c2 fail: ' + c2.message)

  const over = await deliveryCreate.run({ orderNo: no, qty: 50 }, ctx)
  if (over.ok) throw new Error('overship should fail')

  const d3 = await deliveryCreate.run({ orderNo: no, qty: 20 }, ctx)
  if (!d3.ok) throw new Error('d3 create fail: ' + d3.message)
  const c3 = await deliveryConfirm.run({ deliveryNo: (d3.data as any).deliveryNo }, ctx)
  if (!c3.ok) throw new Error('c3 fail: ' + c3.message)

  const ord3 = await db.order.findUnique({ where: { id: order.id } })
  if (ord3?.status !== 'SHIPPED') throw new Error(`expected SHIPPED got ${ord3?.status}`)

  console.log('✓ 部分出货 + 超量硬拦 + 最终 SHIPPED 通过')
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
