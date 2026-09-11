/**
 * G3 上下文冒烟
 *
 *   npx tsx scripts/smoke-context.ts
 */

import '../scripts/bootstrap-env.ts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import {
  isSensoryContextRef,
  setSensoryFocus,
  customerInjectFromFocus,
} from '../src/server/sessionContext'
import { buildContextSummary } from '../src/server/contextSummary'

const __dirname = dirname(fileURLToPath(import.meta.url))
const prisma = new PrismaClient()

if (!isSensoryContextRef('就按上一张图来10个A-100')) {
  console.error('✗ isSensoryContextRef')
  process.exit(1)
}
console.log('✓ isSensoryContextRef')

const zhang = await prisma.customer.findFirst({ where: { name: '张三' } })
if (!zhang) {
  console.error('缺少种子客户张三')
  process.exit(1)
}

setSensoryFocus('smoke-g3', {
  modality: 'image',
  customerId: zhang.id,
  customerLabel: `${zhang.name}（${zhang.code}）`,
  correlationId: `CUS:${zhang.id}`,
  at: new Date().toISOString(),
})

const inject = customerInjectFromFocus('就按上一张图来10个A-100', {
  modality: 'image',
  customerId: zhang.id,
  customerLabel: zhang.name,
  correlationId: `CUS:${zhang.id}`,
  at: new Date().toISOString(),
})
if (inject !== '张三') {
  console.error('✗ customerInjectFromFocus', inject)
  process.exit(1)
}
console.log('✓ customerInjectFromFocus → 张三')

const summary = await buildContextSummary(prisma, [
  {
    slot: 'customer',
    field: 'customerId',
    title: '客户',
    raw: '张三',
    value: zhang.id,
    label: zhang.name,
    confidence: 0.95,
    source: 'user',
    required: true,
  },
  {
    slot: 'product',
    field: 'productId',
    title: '产品',
    raw: 'A-100',
    value: (await prisma.product.findFirst({ where: { model: 'A-100' } }))!.id,
    confidence: 0.95,
    source: 'user',
    required: true,
  },
])
if (!summary.lines.some((l) => l.kind === 'credit' && l.text.includes('张三'))) {
  console.error('✗ buildContextSummary credit', summary)
  process.exit(1)
}
console.log('✓ buildContextSummary 含信用行')

await prisma.$disconnect()
console.log('\n全部通过')
