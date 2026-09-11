/**
 * 从 CSV 文件导入企业别名（默认 candidate，须 API 批准后才 active）
 *
 *   npx tsx scripts/import-enterprise-aliases.ts path/to/aliases.csv
 *
 * CSV 列：entityKind,alias,entityIdOrCode,source,status(optional)
 * 示例：
 *   customer,张总,C001,official,active
 *   product,B型,B-200,invoice,candidate
 */

import '../scripts/bootstrap-env.ts'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { importEnterpriseAliasesCsv } from '../src/server/enterpriseAlias'

const path = process.argv[2]
if (!path) {
  console.error('用法: npx tsx scripts/import-enterprise-aliases.ts <csv-file>')
  process.exit(1)
}

const prisma = new PrismaClient()

async function main() {
  const csv = readFileSync(path, 'utf-8')
  const results = await importEnterpriseAliasesCsv(prisma, csv, {
    defaultStatus: 'candidate',
    approvedBy: 'import-cli',
  })
  const ok = results.filter((r) => r.ok).length
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.alias}${r.error ? ` — ${r.error}` : ''}`)
  }
  console.log(`\n导入完成：${ok}/${results.length} 成功`)
  await prisma.$disconnect()
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
