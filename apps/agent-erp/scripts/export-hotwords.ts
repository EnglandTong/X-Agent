/**
 * 从主数据导出 ASR 热词表（客户名/编码、产品型号/名称、仓库）
 *
 *   npm run hotwords
 *   → app/models/asr/hotwords.txt
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '../models/asr')
const OUT = join(OUT_DIR, 'hotwords.txt')

async function main() {
  const db = new PrismaClient()
  const [customers, products, warehouses, aliases] = await Promise.all([
    db.customer.findMany({ select: { name: true, code: true } }),
    db.product.findMany({ select: { model: true, name: true } }),
    db.inventory.findMany({ distinct: ['warehouse'], select: { warehouse: true } }),
    db.enterpriseAlias.findMany({ where: { status: 'active' }, select: { alias: true } }),
  ])

  const words = new Set<string>()
  for (const c of customers) {
    if (c.name?.trim()) words.add(c.name.trim())
    if (c.code?.trim()) words.add(c.code.trim())
  }
  for (const p of products) {
    if (p.model?.trim()) words.add(p.model.trim())
    if (p.name?.trim()) words.add(p.name.trim())
  }
  for (const w of warehouses) {
    if (w.warehouse?.trim()) words.add(w.warehouse.trim())
  }
  for (const a of aliases) {
    if (a.alias?.trim()) words.add(a.alias.trim())
  }

  // 业务高频口语（同音/别称可后续扩）
  for (const extra of ['开单', '出货', '确认', '取消', '查一下', '库存', '信用']) {
    words.add(extra)
  }

  const lines = [...words].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf-8')
  console.log(`✓ 热词 ${lines.length} 条 → ${OUT}`)
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
