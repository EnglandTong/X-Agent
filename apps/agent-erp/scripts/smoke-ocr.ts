/**
 * OCR 冒烟：解析 + API + candidate 别名不入 active
 *
 *   npx tsx scripts/smoke-ocr.ts
 */

import '../scripts/bootstrap-env.ts'
import { parseWechatOrderText, wechatOrderToUtterance } from '../src/server/ocrWechat'
import { recordOcrAliasCandidates } from '../src/server/ocrSuggest'
import { lookupEnterpriseAlias } from '../src/server/enterpriseAlias'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const text = `微信订单
买家：张三公司
商品：A-100
数量：50`

const fields = parseWechatOrderText(text)
const utterance = wechatOrderToUtterance(fields)
if (utterance !== '给张三公司来50个A-100') {
  console.error('✗ utterance', utterance)
  process.exit(1)
}
console.log('✓ parse + utterance')

const suggestions = await recordOcrAliasCandidates(prisma, text, fields)
if (!suggestions.some((s) => s.phrase === '张三公司')) {
  console.error('✗ alias suggestion missing 张三公司', suggestions)
  process.exit(1)
}
const hit = await lookupEnterpriseAlias(prisma, '张三公司', 'customer')
if (hit !== null) {
  console.error('✗ candidate must not be active', hit)
  process.exit(1)
}
console.log('✓ OCR alias → candidate only')

await prisma.$disconnect()
console.log('\n全部通过')
