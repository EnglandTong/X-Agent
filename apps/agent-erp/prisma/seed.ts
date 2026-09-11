/**
 * 种子数据：仅覆盖「销售订单 → 出货」一条线
 * 其中刻意造了两个「张」姓客户，用于验证歧义消解（模型必须弹候选，不自己拍板）
 */
import '../scripts/bootstrap-env.ts'
import { PrismaClient } from '@prisma/client'
import { upsertEnterpriseAlias } from '../src/server/enterpriseAlias'

const prisma = new PrismaClient()

function daysFromNow(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

async function main() {
  // 清空（验证阶段可以反复跑）
  await prisma.panel.deleteMany()
  await prisma.deliveryItem.deleteMany()
  await prisma.delivery.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.enterpriseAlias.deleteMany()
  await prisma.product.deleteMany()
  await prisma.customer.deleteMany()

  // --- 客户 ---
  const customers = await Promise.all([
    prisma.customer.create({
      data: { code: 'C001', name: '张三', level: 'A', lastWarehouse: '华东仓', creditLimit: 200000, creditUsed: 42000 },
    }),
    prisma.customer.create({
      data: { code: 'C002', name: '张伟', level: 'B', lastWarehouse: '华南仓', creditLimit: 80000, creditUsed: 15000 },
    }),
    prisma.customer.create({
      data: { code: 'C003', name: '李四', level: 'A', lastWarehouse: '华东仓', creditLimit: 150000, creditUsed: 0 },
    }),
    prisma.customer.create({
      data: { code: 'C004', name: '王五', level: 'C', lastWarehouse: '华北仓', creditLimit: 30000, creditUsed: 28000 },
    }),
  ])

  // --- 产品 ---
  const products = await Promise.all([
    prisma.product.create({ data: { model: 'A-100', name: '标准件A型', price: 12.5 } }),
    prisma.product.create({ data: { model: 'B-200', name: '标准件B型', price: 28.0 } }),
    prisma.product.create({ data: { model: 'C-300', name: '标准件C型', price: 45.0 } }),
  ])

  // --- 库存 ---
  const warehouses = ['华东仓', '华南仓', '华北仓']
  for (const p of products) {
    for (const w of warehouses) {
      await prisma.inventory.create({
        data: { productId: p.id, warehouse: w, qty: 500 + Math.floor(Math.random() * 1500), reserved: 0 },
      })
    }
  }

  // --- 历史订单（供 order.query 验证）---
  const samples = [
    { ci: 0, pi: 0, qty: 200, days: -28, status: 'SHIPPED' },
    { ci: 0, pi: 1, qty: 80, days: -14, status: 'CONFIRMED' },
    { ci: 2, pi: 0, qty: 150, days: -7, status: 'CONFIRMED' },
    { ci: 3, pi: 2, qty: 30, days: -3, status: 'DRAFT' },
  ]

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const c = customers[s.ci]
    const p = products[s.pi]
    await prisma.order.create({
      data: {
        no: 'SO-2026-' + String(1001 + i),
        customerId: c.id,
        warehouse: c.lastWarehouse,
        status: s.status,
        deliveryDate: daysFromNow(s.days + 14),
        totalAmount: s.qty * p.price,
        createdAt: daysFromNow(s.days),
        items: {
          create: [{ productId: p.id, qty: s.qty, unitPrice: p.price, amount: s.qty * p.price }],
        },
      },
    })
  }

  // --- 企业别名（B 层）—— active 可消解；candidate 须人工批准后才生效
  await upsertEnterpriseAlias(prisma, {
    entityKind: 'customer',
    entityId: customers[0].id,
    alias: '张总',
    source: 'official',
    status: 'active',
    approvedBy: 'seed',
  })
  await upsertEnterpriseAlias(prisma, {
    entityKind: 'product',
    entityId: products[1].id,
    alias: 'B型',
    source: 'official',
    status: 'active',
    approvedBy: 'seed',
  })
  await upsertEnterpriseAlias(prisma, {
    entityKind: 'warehouse',
    entityId: '华东仓',
    alias: '华东',
    source: 'official',
    status: 'active',
    approvedBy: 'seed',
  })
  // 候选：未批准前 resolve 不得命中
  await upsertEnterpriseAlias(prisma, {
    entityKind: 'customer',
    entityId: customers[2].id,
    alias: '老李',
    source: 'import',
    status: 'candidate',
  })

  const [cc, pc, oc, ac] = await Promise.all([
    prisma.customer.count(),
    prisma.product.count(),
    prisma.order.count(),
    prisma.enterpriseAlias.count(),
  ])
  console.log(`✅ 种子完成：客户 ${cc} · 产品 ${pc} · 订单 ${oc} · 企业别名 ${ac}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
