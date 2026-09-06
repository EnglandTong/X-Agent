/**
 * 个人用语表夹具评测（不污染主基线）
 *
 *   npx tsx scripts/eval-lexicon.ts
 *
 * 流程：写入「老王→张三」「开张单→order.create」「圆珠笔→A-100」后跑 interpret，
 * 再清理夹具用语。主 eval 默认空表，不受影响。
 */

import { PrismaClient } from '@prisma/client'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../src/server/compile'
import { interpret } from '../src/server/agent'
import { upsertLexeme, phraseNorm, proposeFromConfirm, rejectLexeme } from '../src/server/lexicon'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SCHEMA_DIR = join(ROOT, 'src/schema')

function loadSchemas() {
  const tools = new Map<string, ReturnType<typeof compile>>()
  const schemas = new Map<string, any>()
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf-8'))
    const verb = raw['x-verb'] ?? f.replace(/\.json$/, '')
    schemas.set(verb, raw)
    tools.set(verb, compile(raw))
  }
  return { tools, schemas }
}

async function main() {
  const prisma = new PrismaClient()
  const { tools, schemas } = loadSchemas()

  const zhang = await prisma.customer.findFirst({ where: { name: '张三' } })
  const a100 = await prisma.product.findFirst({ where: { model: 'A-100' } })
  if (!zhang || !a100) {
    console.error('种子数据缺少张三 / A-100，请先 npm run db:seed')
    process.exit(1)
  }

  // 清理旧夹具
  await prisma.personalLexeme.deleteMany({
    where: {
      OR: [
        { phraseNorm: phraseNorm('老王') },
        { phraseNorm: phraseNorm('开张单') },
        { phraseNorm: phraseNorm('圆珠笔') },
      ],
    },
  })

  await upsertLexeme(prisma, {
    phrase: '老王',
    kind: 'slot',
    slot: 'customer',
    targetId: zhang.id,
    targetLabel: `${zhang.name}（${zhang.code}）`,
    source: 'explicit',
  })
  await upsertLexeme(prisma, {
    phrase: '开张单',
    kind: 'verb',
    verb: 'order.create',
    source: 'explicit',
  })
  await upsertLexeme(prisma, {
    phrase: '圆珠笔',
    kind: 'slot',
    slot: 'product',
    targetId: a100.id,
    targetLabel: `${a100.model} ${a100.name}`,
    source: 'explicit',
  })

  const cases = [
    {
      id: 'L1',
      utterance: '开张单',
      expectVerb: 'order.create',
    },
    {
      id: 'L2',
      utterance: '给老王来10个圆珠笔',
      expectVerb: 'order.create',
      expectCustomerId: zhang.id,
      expectProductId: a100.id,
    },
  ]

  let pass = 0
  for (const c of cases) {
    const r = await interpret(c.utterance, {
      tools,
      schemas,
      ctx: { db: prisma, today: new Date('2026-09-06T12:00:00+08:00') },
      dict: {
        customers: await prisma.customer.findMany({
          select: { id: true, name: true, code: true },
        }),
        products: await prisma.product.findMany({
          select: { id: true, model: true, name: true },
        }),
      },
      llm: { provider: 'rules', apiKey: '', baseUrl: '', model: '', timeoutMs: 5000 },
      today: new Date('2026-09-06T12:00:00+08:00'),
    })

    const cust = r.slots.find((s) => s.slot === 'customer')
    const prod = r.slots.find((s) => s.slot === 'product')
    const verbOk = r.verb === c.expectVerb
    const custOk = !c.expectCustomerId || cust?.value === c.expectCustomerId
    const prodOk = !c.expectProductId || prod?.value === c.expectProductId
    const ok = verbOk && custOk && prodOk
    if (ok) pass++
    console.log(
      `${ok ? '✓' : '✗'} ${c.id} verb=${r.verb}` +
        (cust ? ` customer=${cust.label ?? cust.value}` : '') +
        (prod ? ` product=${prod.label ?? prod.value}` : '') +
        (cust?.note ? ` [${cust.note}]` : '')
    )
  }

  // 回归：reject 后再 propose，不得再弹出同一说法
  const rejectRow = await upsertLexeme(prisma, {
    phrase: '老王',
    kind: 'slot',
    slot: 'customer',
    targetId: zhang.id,
    targetLabel: `${zhang.name}（${zhang.code}）`,
    source: 'explicit',
  })
  await rejectLexeme(prisma, rejectRow.id)
  const proposals = await proposeFromConfirm(prisma, {
    utterance: '给老王来10个A-100',
    verb: 'order.create',
    slots: [
      {
        slot: 'customer',
        field: 'customerId',
        raw: '老王',
        value: null,
        label: zhang.name,
        candidates: [{ id: zhang.id, label: zhang.name }],
      },
    ],
    submittedValues: { customerId: zhang.id },
  })
  const rejectProposeOk = !proposals.some(
    (p) => p.kind === 'slot' && p.slot === 'customer' && phraseNorm(p.phrase) === phraseNorm('老王')
  )
  if (rejectProposeOk) pass++
  console.log(
    `${rejectProposeOk ? '✓' : '✗'} L-reject propose empty after reject (got ${proposals.length})`
  )
  const totalCases = cases.length + 1

  // 清理夹具，避免污染日常
  await prisma.personalLexeme.deleteMany({
    where: {
      OR: [
        { phraseNorm: phraseNorm('老王') },
        { phraseNorm: phraseNorm('开张单') },
        { phraseNorm: phraseNorm('圆珠笔') },
      ],
    },
  })

  console.log(`\n个人用语夹具：${pass}/${totalCases} 通过`)
  await prisma.$disconnect()
  process.exit(pass === totalCases ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
