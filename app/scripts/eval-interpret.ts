/**
 * 评测：模型 vs 规则 双跑 interpret
 *
 *   npx tsx scripts/eval-interpret.ts
 *   npx tsx scripts/eval-interpret.ts --engine=rules
 *   npx tsx scripts/eval-interpret.ts --engine=both
 *
 * 输出：
 *   eval/results/summary.md
 *   eval/results/latest.json
 *   eval/failures.jsonl（错例追加/覆盖本次）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { compile } from '../src/server/compile'
import { interpret, hydrateInference, applyListPriceFallback } from '../src/server/agent'
import { loadSettings, type LlmSettings } from '../src/server/settings'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EVAL_DIR = join(ROOT, 'eval')
const RESULTS = join(EVAL_DIR, 'results')
const SCHEMA_DIR = join(ROOT, 'src/schema')

interface Sample {
  id: string
  utterance: string
  verb: string
  slots: Record<string, string>
}

type Tag = 'A' | 'B' | 'C' | 'D' | 'OK'

function loadSamples(): Sample[] {
  const path = join(EVAL_DIR, 'utterances.jsonl')
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sample)
}

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

function norm(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function slotHit(expected: Record<string, string>, actualRaw: Record<string, unknown>) {
  const keys = Object.keys(expected)
  let hit = 0
  const detail: Record<string, boolean> = {}
  for (const k of keys) {
    const ok = norm(actualRaw[k]).includes(norm(expected[k])) || norm(expected[k]).includes(norm(actualRaw[k]))
    detail[k] = ok
    if (ok) hit++
  }
  return { hit, total: keys.length, detail }
}

async function runOne(
  sample: Sample,
  engine: 'rules' | 'llm',
  prisma: PrismaClient,
  tools: Map<string, any>,
  schemas: Map<string, any>,
  settings: LlmSettings,
  today: Date
) {
  const [customers, products] = await Promise.all([
    prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
    prisma.product.findMany({ select: { id: true, model: true, name: true } }),
  ])

  const llm: LlmSettings | null =
    engine === 'llm'
      ? { ...settings, provider: 'openai' }
      : { ...settings, provider: 'rules', apiKey: '' }

  const result = await interpret(sample.utterance, {
    tools,
    schemas,
    ctx: { db: prisma, today },
    dict: { customers, products },
    llm,
    today,
  })

  let slots = await hydrateInference(result.slots, schemas.get(result.verb), { db: prisma })
  slots = await applyListPriceFallback(slots, schemas.get(result.verb), { db: prisma })

  const actualRaw: Record<string, unknown> = {}
  for (const s of slots) {
    if (s.raw != null && s.raw !== '') actualRaw[s.slot] = s.raw
  }

  const verbOk = result.verb === sample.verb
  const slot = slotHit(sample.slots, actualRaw)
  return {
    id: sample.id,
    utterance: sample.utterance,
    expectedVerb: sample.verb,
    actualVerb: result.verb,
    verbOk,
    engine: result.engine,
    llmError: result.llm?.error,
    slotHit: slot.hit,
    slotTotal: slot.total,
    slotDetail: slot.detail,
    expectedSlots: sample.slots,
    actualSlots: actualRaw,
    allSlotsOk: slot.hit === slot.total && slot.total > 0 ? true : slot.total === 0 && verbOk,
  }
}

function classify(rules: Awaited<ReturnType<typeof runOne>>, llm: Awaited<ReturnType<typeof runOne>> | null): Tag {
  const rOk = rules.verbOk && rules.slotHit === rules.slotTotal
  if (!llm || llm.llmError) {
    return rOk ? 'OK' : 'C'
  }
  const lOk = llm.verbOk && llm.slotHit === llm.slotTotal
  if (lOk && rOk) return 'OK'
  if (!lOk && rOk) return 'B' // 模型错、规则对
  if (lOk && !rOk) return 'D' // 模型对、规则错
  if (!lOk && !rOk) {
    // 模型漏抽但规则能抽到部分 → A；两者都挂 → C
    if (rules.slotHit > llm.slotHit) return 'A'
    return 'C'
  }
  return 'OK'
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--engine='))
  const mode = (arg?.split('=')[1] ?? 'both') as 'rules' | 'llm' | 'both'

  mkdirSync(RESULTS, { recursive: true })
  const prisma = new PrismaClient()
  const { tools, schemas } = loadSchemas()
  const settings = loadSettings()
  const today = new Date('2026-09-06T12:00:00+08:00')
  const samples = loadSamples()

  const hasKey = Boolean(settings.apiKey && settings.provider === 'openai')
  const runLlm = (mode === 'llm' || mode === 'both') && hasKey
  if ((mode === 'llm' || mode === 'both') && !hasKey) {
    console.warn('⚠️  未配置 openai API Key（.env.local），本次只跑 rules；填 Key 后重跑 --engine=both')
  }

  const rows: any[] = []
  const failures: any[] = []

  for (const sample of samples) {
    const rules = await runOne(sample, 'rules', prisma, tools, schemas, settings, today)
    const llm = runLlm ? await runOne(sample, 'llm', prisma, tools, schemas, settings, today) : null
    const tag = classify(rules, llm)
    const row = { id: sample.id, utterance: sample.utterance, tag, rules, llm }
    rows.push(row)
    if (tag !== 'OK') {
      failures.push({
        utterance: sample.utterance,
        expected: { verb: sample.verb, slots: sample.slots },
        actual: {
          rules: { verb: rules.actualVerb, slots: rules.actualSlots },
          llm: llm ? { verb: llm.actualVerb, slots: llm.actualSlots, error: llm.llmError } : null,
        },
        engine: llm?.engine ?? rules.engine,
        tag,
      })
    }
    const mark = tag === 'OK' ? '✓' : tag
    console.log(
      `${mark} ${sample.id} rules=${rules.verbOk ? 'V' : 'x'}/${rules.slotHit}/${rules.slotTotal}` +
        (llm ? ` llm=${llm.verbOk ? 'V' : 'x'}/${llm.slotHit}/${llm.slotTotal}` : ' llm=skip')
    )
  }

  const verbRules = rows.filter((r) => r.rules.verbOk).length / rows.length
  const slotRules =
    rows.reduce((a, r) => a + r.rules.slotHit, 0) / Math.max(1, rows.reduce((a, r) => a + r.rules.slotTotal, 0))
  const verbLlm = runLlm ? rows.filter((r) => r.llm?.verbOk).length / rows.length : null
  const slotLlm = runLlm
    ? rows.reduce((a, r) => a + (r.llm?.slotHit ?? 0), 0) /
      Math.max(1, rows.reduce((a, r) => a + (r.llm?.slotTotal ?? 0), 0))
    : null

  const byTag: Record<string, number> = {}
  for (const r of rows) byTag[r.tag] = (byTag[r.tag] ?? 0) + 1

  const summary = {
    at: new Date().toISOString(),
    n: rows.length,
    llmRan: runLlm,
    model: runLlm ? settings.model : null,
    verbAccuracy: { rules: verbRules, llm: verbLlm },
    slotHitRate: { rules: slotRules, llm: slotLlm },
    tags: byTag,
  }

  writeFileSync(join(RESULTS, 'latest.json'), JSON.stringify({ summary, rows }, null, 2), 'utf-8')
  writeFileSync(join(EVAL_DIR, 'failures.jsonl'), failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''), 'utf-8')

  const md = `# 评测摘要 · 模型 vs 规则

生成时间：${summary.at}
样本数：${summary.n}
LLM 实跑：${summary.llmRan ? `是（${summary.model}）` : '否（未填 Key 或未启用）'}

| 指标 | 规则 | 模型 |
|---|---|---|
| 动词准确率 | ${(verbRules * 100).toFixed(1)}% | ${verbLlm == null ? '—' : (verbLlm * 100).toFixed(1) + '%'} |
| 槽位命中率 | ${(slotRules * 100).toFixed(1)}% | ${slotLlm == null ? '—' : (slotLlm * 100).toFixed(1) + '%'} |

## 错例分类

| Tag | 含义 | 条数 |
|---|---|---|
| A | 模型漏抽（规则更好） | ${byTag.A ?? 0} |
| B | 模型抽错（规则对） | ${byTag.B ?? 0} |
| C | 两者都错 | ${byTag.C ?? 0} |
| D | 模型对规则错 | ${byTag.D ?? 0} |
| OK | 通过 | ${byTag.OK ?? 0} |

> 评测价值：知道哪些场景必须保留规则兜底，不是二选一。
`
  writeFileSync(join(RESULTS, 'summary.md'), md, 'utf-8')
  console.log('\n' + md)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
