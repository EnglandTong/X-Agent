/**
 * Wave 3 冒烟：多行订单 + 标量 qty 硬错 + 预留出货同步 + 超量硬拦
 *   npx tsx scripts/smoke-multiline-reserve.ts
 */
import { PrismaClient } from '@prisma/client'
import { orderCreate } from '../src/server/verbs/order.create'
import { orderConfirm } from '../src/server/verbs/order.confirm'
import { deliveryCreate } from '../src/server/verbs/delivery.create'
import { deliveryConfirm } from '../src/server/verbs/delivery.confirm'
import { inventoryReserve } from '../src/server/verbs/inventory.reserve'
import { extractOrderLinesForTest } from '../src/server/agent'

async function main() {
  const db = new PrismaClient()
  const ctx = { db, actor: 'owner' }
  const customer = await db.customer.findFirst({ where: { name: '张三' } })
  const pA = await db.product.findFirst({ where: { model: 'A-100' } })
  const pB = await db.product.findFirst({ where: { model: 'B-200' } })
  if (!customer || !pA || !pB) throw new Error('need seed (张三 / A-100 / B-200)')

  // --- NL 多行抽取 ---
  const nl = extractOrderLinesForTest('给张三来100个A-100和200个B-200', {
    customers: [{ id: 'c1', name: '张三', code: 'C001' }],
    products: [
      { id: 'p1', model: 'A-100', name: '标准件A型' },
      { id: 'p2', model: 'B-200', name: '标准件B型' },
    ],
  })
  if (nl.length !== 2 || nl[0].product !== 'A-100' || nl[0].quantity !== '100') {
    throw new Error('NL extract line1 fail: ' + JSON.stringify(nl))
  }
  if (nl[1].product !== 'B-200' || nl[1].quantity !== '200') {
    throw new Error('NL extract line2 fail: ' + JSON.stringify(nl))
  }

  for (const p of [pA, pB]) {
    await db.inventory.upsert({
      where: { productId_warehouse: { productId: p.id, warehouse: '华东仓' } },
      create: { productId: p.id, warehouse: '华东仓', qty: 1000, reserved: 0 },
      update: { qty: 1000, reserved: 0 },
    })
  }

  // ========== 1) 多行建单 ==========
  const created = await orderCreate.run(
    {
      customerId: customer.id,
      warehouseId: '华东仓',
      items: [
        { productId: pA.id, qty: 100, unitPrice: 12.5 },
        { productId: pB.id, qty: 80, unitPrice: 28 },
      ],
    },
    ctx
  )
  if (!created.ok) throw new Error('multi create fail: ' + created.message)
  const orderNo = (created.data as any).no as string
  if ((created.data as any).lineCount !== 2) {
    throw new Error(`expected lineCount 2 got ${(created.data as any).lineCount}`)
  }

  const confirmed = await orderConfirm.run({ orderNo }, ctx)
  if (!confirmed.ok) throw new Error('confirm fail: ' + confirmed.message)

  // ========== 2) 多行 + 标量 qty → 硬错 ==========
  const badQty = await deliveryCreate.run({ orderNo, qty: 50 }, ctx)
  if (badQty.ok) throw new Error('multi-line scalar qty should hard-fail')
  if (!/不能用标量 qty|多行/.test(badQty.message)) {
    throw new Error('unexpected hard-fail message: ' + badQty.message)
  }

  // ========== 3) 省略 qty → 按各行剩余量出货 ==========
  const dAll = await deliveryCreate.run({ orderNo }, ctx)
  if (!dAll.ok) throw new Error('delivery all remaining fail: ' + dAll.message)
  const lines = (dAll.data as any).lines as Array<{ product: string; qty: number }>
  if (lines.length !== 2) throw new Error(`expected 2 delivery lines got ${lines.length}`)
  const byModel = Object.fromEntries(lines.map((l) => [l.product, l.qty]))
  if (byModel['A-100'] !== 100 || byModel['B-200'] !== 80) {
    throw new Error('unexpected delivery lines: ' + JSON.stringify(byModel))
  }

  // 删掉该草稿，留给后面「全部出完」步骤
  await db.deliveryItem.deleteMany({
    where: { delivery: { no: (dAll.data as any).deliveryNo } },
  })
  await db.delivery.delete({ where: { no: (dAll.data as any).deliveryNo } })

  // ========== 4) 预留 50 再出 50 → reserved 同步释放 ==========
  const single = await orderCreate.run(
    {
      customerId: customer.id,
      productId: pA.id,
      qty: 50,
      unitPrice: 12.5,
      warehouseId: '华东仓',
    },
    ctx
  )
  if (!single.ok) throw new Error('single create fail: ' + single.message)
  const sNo = (single.data as any).no as string
  const sConf = await orderConfirm.run({ orderNo: sNo }, ctx)
  if (!sConf.ok) throw new Error('single confirm fail: ' + sConf.message)

  const midBeforeReserve = await db.inventory.findFirst({
    where: { productId: pA.id, warehouse: '华东仓' },
  })
  if (!midBeforeReserve) throw new Error('no inv')

  const res = await inventoryReserve.run(
    { productId: pA.id, warehouseId: '华东仓', qty: 50 },
    ctx
  )
  if (!res.ok) throw new Error('reserve fail: ' + res.message)

  const mid = await db.inventory.findFirst({
    where: { productId: pA.id, warehouse: '华东仓' },
  })
  if (!mid || mid.reserved < 50) throw new Error(`reserved expected ≥50 got ${mid?.reserved}`)

  const d1 = await deliveryCreate.run({ orderNo: sNo, qty: 50 }, ctx)
  if (!d1.ok) throw new Error('d1 fail: ' + d1.message)
  const c1 = await deliveryConfirm.run({ deliveryNo: (d1.data as any).deliveryNo }, ctx)
  if (!c1.ok) throw new Error('c1 fail: ' + c1.message)

  const after = await db.inventory.findFirst({
    where: { productId: pA.id, warehouse: '华东仓' },
  })
  if (!after) throw new Error('no after inv')
  if (after.qty !== mid.qty - 50) {
    throw new Error(`qty expected ${mid.qty - 50} got ${after.qty}`)
  }
  if (after.reserved !== mid.reserved - 50) {
    throw new Error(
      `reserved should drop by 50: before ${mid.reserved} after ${after.reserved}`
    )
  }
  const avail = after.qty - after.reserved
  const availBeforeShip = mid.qty - mid.reserved
  if (avail !== availBeforeShip) {
    throw new Error(
      `available should stay ${availBeforeShip} after reserve+ship, got ${avail}`
    )
  }

  // ========== 5) 超量硬拦 ==========
  const over = await deliveryCreate.run({ orderNo: sNo, qty: 1 }, ctx)
  if (over.ok) throw new Error('overship on fully shipped order should fail')

  // ========== 6) 多行订单确认出货 → SHIPPED ==========
  const dMulti = await deliveryCreate.run({ orderNo }, ctx)
  if (!dMulti.ok) throw new Error('multi ship create fail: ' + dMulti.message)
  const cMulti = await deliveryConfirm.run(
    { deliveryNo: (dMulti.data as any).deliveryNo },
    ctx
  )
  if (!cMulti.ok) throw new Error('multi ship confirm fail: ' + cMulti.message)
  const ord = await db.order.findFirst({ where: { no: orderNo } })
  if (ord?.status !== 'SHIPPED') throw new Error(`multi order expected SHIPPED got ${ord?.status}`)

  console.log('✓ 多行建单 + NL抽取 + 标量 qty 硬错 + 预留同步释放 + 超量硬拦 通过')
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
