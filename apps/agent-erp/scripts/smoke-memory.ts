/**
 * 记忆写入策略冒烟（决策 #28）+ v2（升格文案 / 共现派生）
 *
 *   npm run smoke:memory
 *
 * 断言：
 *   1. 第一次观察「老张」  → 进候选区（candidate，不参与消解），days=1
 *   2. 同一天再观察一次    → days 仍为 1（同天去重）
 *   3. 第二天再观察        → 升格为 active（≥2 次且跨 ≥2 天）+ promoted + 升格文案
 *   4. 标准名「张三」      → skipped_standard（本来就认得，不记）
 *   5. 噪声（每次不一样）  → 永远停在候选区，凑不满跨天
 *   6. 点「记住」          → 立即生效
 *   7. 共现派生            → 同格两实体出边，minCount 过滤生效
 */

import { PrismaClient } from '@prisma/client'
import { observeUsage, PROMOTE_MIN_DAYS } from '../src/server/lexicon'
import { cooccurFromPanels, formatPromoteNotice } from '../src/server/memory'

const prisma = new PrismaClient()

let failed = 0
function check(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed++
}

async function clean(phrases: string[]) {
  await prisma.lexemeEvidence.deleteMany({ where: { phrase: { in: phrases } } })
  await prisma.personalLexeme.deleteMany({ where: { phrase: { in: phrases } } })
}

async function main() {
  const zhangsan = await prisma.customer.findFirst({ where: { name: '张三' } })
  if (!zhangsan) throw new Error('缺种子客户张三，先跑 npm run setup')

  const TEST = ['老张', '老呃张老', '老呃张']
  await clean([...TEST, '张三'])

  console.log(`升格阈值：跨 ${PROMOTE_MIN_DAYS} 天\n`)

  // 1 · 第一次观察
  const d1 = await observeUsage(prisma, {
    phrase: '老张',
    slot: 'customer',
    targetId: zhangsan.id,
    targetLabel: '张三（C001）',
    today: '2026-09-01',
  })
  check('第一次观察 → 候选区', d1.status === 'candidate' && d1.days === 1, JSON.stringify(d1))

  // 2 · 同一天重复
  const d1b = await observeUsage(prisma, {
    phrase: '老张',
    slot: 'customer',
    targetId: zhangsan.id,
    today: '2026-09-01',
  })
  check('同一天重复 → 天数不涨', d1b.days === 1 && d1b.status === 'candidate', JSON.stringify(d1b))

  // 3 · 第二天 → 升格
  const d2 = await observeUsage(prisma, {
    phrase: '老张',
    slot: 'customer',
    targetId: zhangsan.id,
    targetLabel: '张三（C001）',
    today: '2026-09-02',
  })
  check(
    '跨到第 2 天 → 升格为记忆卡',
    d2.status === 'active' && d2.promoted && d2.days === 2,
    JSON.stringify(d2)
  )
  const tip = formatPromoteNotice({
    phrase: d2.phrase,
    targetLabel: '张三（C001）',
    days: d2.days,
  })
  check(
    'v2 升格文案含「我注意到你常说」',
    tip.includes('我注意到你常说') && tip.includes('老张') && tip.includes('张三'),
    tip
  )

  // 4 · 标准名不记
  const std = await observeUsage(prisma, {
    phrase: '张三',
    slot: 'customer',
    targetId: zhangsan.id,
    today: '2026-09-01',
  })
  check('标准名 → 不记', std.status === 'skipped_standard', JSON.stringify(std))

  // 5 · 噪声：每次长得都不一样，永远凑不满同一目标的跨天
  const n1 = await observeUsage(prisma, {
    phrase: '老呃张老',
    slot: 'customer',
    targetId: zhangsan.id,
    today: '2026-09-01',
  })
  const n2 = await observeUsage(prisma, {
    phrase: '老呃张',
    slot: 'customer',
    targetId: zhangsan.id,
    today: '2026-09-02',
  })
  check(
    '噪声（每次不同）→ 永远停在候选区',
    n1.status === 'candidate' && n2.status === 'candidate' && n2.days === 1,
    `${JSON.stringify(n1)} / ${JSON.stringify(n2)}`
  )

  // 6 · 显式「记住」立即生效（不受跨天限制）
  const exp = await observeUsage(prisma, {
    phrase: '老王',
    slot: 'customer',
    targetId: zhangsan.id,
    targetLabel: '张三（C001）',
    source: 'explicit',
    today: '2026-09-01',
  })
  check('点「记住」→ 立即生效', exp.status === 'active', JSON.stringify(exp))

  // 7 · 共现派生（v2）：写入两格带 entities，再查边
  const sid = `smoke-cooccur-${Date.now()}`
  const a100 = await prisma.product.findFirst({ where: { model: 'A-100' } })
  if (!a100) throw new Error('缺种子产品 A-100')
  const entities = JSON.stringify([
    { type: 'customer', value: zhangsan.id, label: '张三（C001）' },
    { type: 'product', value: a100.id, label: 'A-100 标准件A型' },
  ])
  await prisma.panel.createMany({
    data: [
      {
        sessionId: sid,
        seq: 1,
        verb: 'order.create',
        title: '冒烟',
        status: 'committed',
        entities,
      },
      {
        sessionId: sid,
        seq: 2,
        verb: 'order.create',
        title: '冒烟2',
        status: 'committed',
        entities,
      },
    ],
  })
  const graph = await cooccurFromPanels(prisma, { sessionId: sid, minCount: 2, limit: 10 })
  check(
    'v2 共现：同格两实体跨 2 格 → 1 条边 count=2',
    graph.edges.length === 1 && graph.edges[0].count === 2 && graph.nodes.length === 2,
    JSON.stringify(graph.edges)
  )
  const filtered = await cooccurFromPanels(prisma, { sessionId: sid, minCount: 3, limit: 10 })
  check('v2 共现：minCount=3 过滤掉', filtered.edges.length === 0, JSON.stringify(filtered.edges))
  await prisma.panel.deleteMany({ where: { sessionId: sid } })

  await clean([...TEST, '张三', '老王'])
  console.log(`\n${failed === 0 ? '—— 记忆策略冒烟全部通过 ——' : `—— ${failed} 项失败 ——`}`)
  if (failed) process.exit(1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
