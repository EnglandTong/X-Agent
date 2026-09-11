/**
 * 云端 vs 本地小模型对比（阶段 4）
 *
 *   npx tsx scripts/eval-compare-models.ts
 *
 * 读取 .env.local 当前云端配置跑一遍；若存在 LOCAL_LLM_* 环境变量则再跑本地。
 * 输出 eval/results/compare-models.md —— 达标后再谈内嵌，本脚本不强制上线本地模型。
 *
 * 本地示例（PowerShell）：
 *   $env:LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
 *   $env:LOCAL_LLM_API_KEY="ollama"
 *   $env:LOCAL_LLM_MODEL="qwen3:0.6b"
 *   npx tsx scripts/eval-compare-models.ts
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { compile } from '../src/server/compile'
import { interpret } from '../src/server/agent'
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

function loadSamples(): Sample[] {
  return readFileSync(join(EVAL_DIR, 'utterances.jsonl'), 'utf-8')
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

async function runEngine(
  label: string,
  settings: LlmSettings,
  samples: Sample[],
  prisma: PrismaClient,
  tools: Map<string, any>,
  schemas: Map<string, any>,
  today: Date
) {
  const [customers, products] = await Promise.all([
    prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
    prisma.product.findMany({ select: { id: true, model: true, name: true } }),
  ])

  let verbOk = 0
  let slotHit = 0
  let slotTotal = 0
  let errors = 0

  for (const sample of samples) {
    try {
      const result = await interpret(sample.utterance, {
        tools,
        schemas,
        ctx: { db: prisma, today },
        dict: { customers, products },
        llm: settings,
        today,
      })
      if (result.verb === sample.verb) verbOk++
      for (const [k, v] of Object.entries(sample.slots)) {
        slotTotal++
        const actual = result.slots.find((s) => s.slot === k)?.raw
        if (norm(actual).includes(norm(v)) || norm(v).includes(norm(actual))) slotHit++
      }
      if (result.llm?.error) errors++
    } catch {
      errors++
    }
  }

  return {
    label,
    model: settings.model,
    baseUrl: settings.baseUrl,
    n: samples.length,
    verbAccuracy: verbOk / samples.length,
    slotHitRate: slotTotal ? slotHit / slotTotal : 0,
    errors,
  }
}

async function main() {
  mkdirSync(RESULTS, { recursive: true })
  const prisma = new PrismaClient()
  const { tools, schemas } = loadSchemas()
  const cloud = loadSettings()
  const samples = loadSamples()
  const today = new Date('2026-09-06T12:00:00+08:00')

  const rows: Awaited<ReturnType<typeof runEngine>>[] = []

  // 规则基线
  rows.push(
    await runEngine(
      'rules',
      { ...cloud, provider: 'rules', apiKey: '' },
      samples,
      prisma,
      tools,
      schemas,
      today
    )
  )

  if (cloud.provider === 'openai' && cloud.apiKey && process.env.SKIP_CLOUD !== '1') {
    rows.push(await runEngine('cloud', cloud, samples, prisma, tools, schemas, today))
  } else {
    console.warn('⚠️  云端跳过（无 Key 或 SKIP_CLOUD=1）')
  }

  const localUrl = process.env.LOCAL_LLM_BASE_URL
  const localKey = process.env.LOCAL_LLM_API_KEY ?? 'ollama'
  const localModel = process.env.LOCAL_LLM_MODEL
  if (localUrl && localModel) {
    rows.push(
      await runEngine(
        'local',
        {
          provider: 'openai',
          baseUrl: localUrl.replace(/\/+$/, ''),
          apiKey: localKey,
          model: localModel,
          timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 60000),
        },
        samples,
        prisma,
        tools,
        schemas,
        today
      )
    )
  } else {
    console.warn('⚠️  未设 LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL，跳过 local 列（达标后再配）')
  }

  const md = `# 云端 vs 本地小模型对比

生成时间：${new Date().toISOString()}
样本：主评测集 ${samples.length} 条（\`utterances.jsonl\`）

| 引擎 | 模型 | 动词准确率 | 槽位命中率 | 错误数 |
|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.label} | ${r.model || '—'} | ${(r.verbAccuracy * 100).toFixed(1)}% | ${(r.slotHitRate * 100).toFixed(1)}% | ${r.errors} |`
  )
  .join('\n')}

## 结论门槛（阶段 4 / D9）

- 本地小模型 **动词≥规则** 且 **槽位≥规则×0.95**，或「本地 + 规则兜底」可接受 → 可谈内嵌
- 未达标 → 继续云端；错例改 prompt/消解，不先换更大云端模型

${decide(rows)}

## 怎么复跑本地

\`\`\`powershell
$env:LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
$env:LOCAL_LLM_API_KEY="ollama"
$env:LOCAL_LLM_MODEL="qwen3:0.6b"
$env:SKIP_CLOUD="1"   # 无云端 Key 时
cd app
npm run eval:compare
\`\`\`
`

  writeFileSync(join(RESULTS, 'compare-models.md'), md, 'utf-8')
  writeFileSync(join(RESULTS, 'compare-models.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2), 'utf-8')
  console.log(md)

  // 同步决策摘要到 COMPARE_MODELS.md（可进 git）
  writeFileSync(
    join(EVAL_DIR, 'COMPARE_MODELS.md'),
    `# 小模型对比说明

运行 \`npm run eval:compare\` 生成 \`results/compare-models.md\`。最新结果以该文件为准。

## 当前产品分工（2026-09-09）

| 角色 | 选择 |
|---|---|
| 大脑 | **云端 LLM**（D9：本地 0.6B **未达标**，不切默认） |
| 语音 | **本地 ASR**（SenseVoice）+ interpret 文本规整 |
| 规则 | 无 Key / 失败时回落 |

## 最近一次对比（${new Date().toISOString().slice(0, 10)}）

| 引擎 | 模型 | 动词 | 槽位 |
|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.label} | ${r.model || '—'} | ${(r.verbAccuracy * 100).toFixed(1)}% | ${(r.slotHitRate * 100).toFixed(1)}% |`
  )
  .join('\n')}

${decide(rows)}

## 可选：对比本地 0.6B

\`\`\`powershell
$env:LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
$env:LOCAL_LLM_API_KEY="ollama"
$env:LOCAL_LLM_MODEL="qwen3:0.6b"
$env:SKIP_CLOUD="1"
npm run eval:compare
\`\`\`
`,
    'utf-8'
  )

  await prisma.$disconnect()
}

function decide(rows: Awaited<ReturnType<typeof runEngine>>[]): string {
  const rules = rows.find((r) => r.label === 'rules')
  const local = rows.find((r) => r.label === 'local')
  if (!local) {
    return `### D9 裁决\n\n未跑本地列（缺 \`LOCAL_LLM_*\`）→ **默认档保持云端**。`
  }
  if (!rules) {
    return `### D9 裁决\n\n缺规则基线，无法裁决。`
  }
  const verbOk = local.verbAccuracy + 1e-9 >= rules.verbAccuracy
  const slotOk = local.slotHitRate + 1e-9 >= rules.slotHitRate * 0.95
  if (verbOk && slotOk) {
    return `### D9 裁决\n\n✅ 本地达标（动词 ${(local.verbAccuracy * 100).toFixed(1)}% ≥ 规则 ${(rules.verbAccuracy * 100).toFixed(1)}%；槽位 ${(local.slotHitRate * 100).toFixed(1)}% ≥ 规则×0.95=${(rules.slotHitRate * 0.95 * 100).toFixed(1)}%）→ **可谈内嵌 / 切默认档**。`
  }
  return `### D9 裁决\n\n❌ 本地未达标（动词 ${(local.verbAccuracy * 100).toFixed(1)}% vs 规则 ${(rules.verbAccuracy * 100).toFixed(1)}%；槽位 ${(local.slotHitRate * 100).toFixed(1)}% vs 规则×0.95=${(rules.slotHitRate * 0.95 * 100).toFixed(1)}%）→ **默认档保持云端**；本地仅作设置面板可选。`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
