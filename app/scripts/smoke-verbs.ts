import { PrismaClient } from '@prisma/client'
import { getVerb, listVerbs } from '../src/server/verbs/registry'

const db = new PrismaClient()

async function main() {
  console.log('verbs', listVerbs().length, listVerbs().map((v) => v.name).join(', '))
  const p = await db.product.findFirst({ where: { model: 'A-100' } })
  const c = await db.customer.findFirst({ where: { name: '张三' } })
  const q = await getVerb('inventory.query')!.run({ productId: p!.id }, { db, actor: 't' })
  console.log('inv.query', q.ok, q.message)
  const credit = await getVerb('credit.check')!.run({ customerId: c!.id, amount: 5000 }, { db, actor: 't' })
  console.log('credit', credit.ok, credit.message)
  const ord = await db.order.findFirst({ where: { status: 'CONFIRMED' } })
  const d = await getVerb('delivery.create')!.run({ orderNo: ord!.no }, { db, actor: 't' })
  console.log('delivery.create', d.ok, d.message, (d.data as any)?.deliveryNo)
  if (d.ok) {
    const cf = await getVerb('delivery.confirm')!.run(
      { deliveryNo: (d.data as any).deliveryNo },
      { db, actor: 't' }
    )
    console.log('delivery.confirm', cf.ok, cf.message)
  }
  const cancelTarget = await db.order.findFirst({ where: { status: 'DRAFT' } })
  if (cancelTarget) {
    const ca = await getVerb('order.cancel')!.run(
      { orderNo: cancelTarget.no, reason: '冒烟测试' },
      { db, actor: 't' }
    )
    console.log('order.cancel', ca.ok, ca.message)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
