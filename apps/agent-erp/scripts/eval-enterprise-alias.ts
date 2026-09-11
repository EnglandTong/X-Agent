/**
 * 企业别名（B 层）夹具评测
 *
 *   npx tsx scripts/eval-enterprise-alias.ts
 *
 * 两层验证：
 *   1. lookupEnterpriseAlias 单元（B 层核心）
 *   2. interpret 集成（规则档能抽到 raw 时走 resolve B′）
 */

import { PrismaClient } from '@prisma/client'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../src/server/compile'
import { interpret } from '../src/server/agent'
import { lookupEnterpriseAlias } from '../src/server/enterpriseAlias'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SCHEMA_DIR = join(ROOT, 'src/schema')
const FIXTURE = join(ROOT, 'eval/alias-enterprise.jsonl')

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

type LookupCase = {
  id: string
  kind: 'lookup'
  alias: string
  entityKind: 'customer' | 'product' | 'warehouse'
  expectEntityId?: string
  expectValueKind?: 'customer' | 'product'
  mustResolve: boolean
}

type InterpretCase = {
  id: string
  kind: 'interpret'
  utterance: string
  expectVerb: string
  expectSlot: string
  expectValueKind?: 'customer' | 'product'
  expectValue?: string
  expectAlias?: string
  mustResolve: boolean
  note?: string
}

type Case = LookupCase | InterpretCase

async function main() {
  const prisma = new PrismaClient()
  const { tools, schemas } = loadSchemas()
  const lines = readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const cases: Case[] = lines.map((l) => JSON.parse(l))

  const zhang = await prisma.customer.findFirst({ where: { name: '张三' } })
  const b200 = await prisma.product.findFirst({ where: { model: 'B-200' } })
  if (!zhang || !b200) {
    console.error('种子数据缺少张三 / B-200，请先 npm run db:seed')
    process.exit(1)
  }

  const dict = {
    customers: await prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
    products: await prisma.product.findMany({ select: { id: true, model: true, name: true } }),
  }

  let pass = 0
  for (const c of cases) {
    if (c.kind === 'lookup') {
      const hit = await lookupEnterpriseAlias(prisma, c.alias, c.entityKind)
      let ok = false
      if (c.mustResolve) {
        if (c.expectValueKind === 'customer') ok = hit?.entityId === zhang.id
        else if (c.expectValueKind === 'product') ok = hit?.entityId === b200.id
        else if (c.expectEntityId) ok = hit?.entityId === c.expectEntityId
        else ok = !!hit
      } else {
        ok = hit === null
      }
      if (ok) pass++
      console.log(
        `${ok ? '✓' : '✗'} ${c.id} lookup ${c.alias}@${c.entityKind}` +
          (hit ? ` → ${hit.label}` : ' → (miss)')
      )
      continue
    }

    const r = await interpret(c.utterance, {
      tools,
      schemas,
      ctx: { db: prisma, today: new Date('2026-09-06T12:00:00+08:00') },
      dict,
      llm: { provider: 'rules', apiKey: '', baseUrl: '', model: '', timeoutMs: 5000 },
      today: new Date('2026-09-06T12:00:00+08:00'),
    })

    const slot = r.slots.find((s) => s.slot === c.expectSlot)
    const verbOk = r.verb === c.expectVerb

    let resolveOk = false
    if (c.mustResolve) {
      if (c.expectValue) {
        resolveOk = slot?.value === c.expectValue
      } else if (c.expectValueKind === 'customer') {
        resolveOk = slot?.value === zhang.id
      } else if (c.expectValueKind === 'product') {
        resolveOk = slot?.value === b200.id
      } else {
        resolveOk = !!slot?.value
      }
      const note = slot?.note ?? ''
      if (c.expectAlias && resolveOk) {
        resolveOk = note.includes('企业别名')
      }
    } else {
      resolveOk = !slot?.note?.includes('企业别名')
      if (c.expectAlias) {
        const ent = await lookupEnterpriseAlias(prisma, c.expectAlias, 'customer')
        resolveOk = resolveOk && ent === null
      }
    }

    const ok = verbOk && resolveOk
    if (ok) pass++
    console.log(
      `${ok ? '✓' : '✗'} ${c.id} verb=${r.verb}` +
        (slot ? ` ${c.expectSlot}=${slot.label ?? slot.value}` : '') +
        (slot?.note ? ` [${slot.note}]` : '') +
        (c.note && !ok ? ` (${c.note})` : '')
    )
  }

  console.log(`\n企业别名夹具：${pass}/${cases.length} 通过`)
  await prisma.$disconnect()
  process.exit(pass === cases.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
