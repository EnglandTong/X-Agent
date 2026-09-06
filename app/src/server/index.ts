/**
 * AGT-ERP · W0 服务入口
 *
 * 路由刻意保持极简 —— 这里没有 /api/orders、/api/customers、/api/products，
 * 因为「能做什么」由动词层表达，不是由 REST 资源表达。
 *
 *   GET  /api/verbs              这台系统能做什么（自省）
 *   GET  /api/schema/:verb       拿 Formily Schema（给 UI 渲染表单）
 *   GET  /api/tools              拿编译后的 Tool Schema（给模型当工具定义）
 *   POST /api/interpret          一句话 → 意图 + 槽位（Agent 层）
 *   POST /api/verbs/:name/run    执行动词（领域层）
 *   GET  /api/entities/:kind     实体选项（供表单下拉框异步加载）
 */

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { PrismaClient } from '@prisma/client'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile, loadVerbs } from './compile'
import { getVerb, listVerbs } from './verbs/registry'
import { interpret, hydrateInference, applyListPriceFallback } from './agent'
import { ping } from './llm'
import { loadSettings, saveSettings, publicView, type LlmSettings } from './settings'
import {
  recordPanel,
  listPanels,
  prepareRevision,
  getChain,
} from './panels'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const SCHEMA_DIR = join(ROOT, 'src/schema')

const prisma = new PrismaClient()
const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '0.0.0.0'

/**
 * 模型配置放在一个可变容器里 —— 设置面板保存后要立即生效，不能等重启。
 * key 只存在于服务端内存与 .env.local，前端永远只拿到掩码。
 */
const runtime = { settings: loadSettings() }
console.log(
  `🧠 Agent 引擎：${runtime.settings.provider === 'openai' ? `${runtime.settings.model} @ ${runtime.settings.baseUrl}` : '规则引擎（rules）'}`
)

// ---------------------------------------------------------------- 启动时编译 Schema

type RawSchema = Record<string, any>
const rawSchemas = new Map<string, RawSchema>()
const tools = new Map<string, ReturnType<typeof compile>>()

for (const verb of ['order.query', 'order.create', 'order.confirm']) {
  const file = join(SCHEMA_DIR, `${verb}.json`)
  if (!existsSync(file)) {
    console.warn(`⚠️  缺少 Schema：${file}`)
    continue
  }
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  rawSchemas.set(verb, raw)
  tools.set(verb, compile(raw))
}

/**
 * 用数据库里的真实值覆写 Schema 的静态声明。
 *
 * 为什么两边都写：Schema 里的 enum 不是为了存数据，而是为了让编译器能校验
 * 「声明了 enum 消解却没给列表」这类配置错误；运行期的合法值以数据库为准。
 */
async function hydrateEnums() {
  const rows = await prisma.inventory.findMany({
    distinct: ['warehouse'],
    select: { warehouse: true },
  })
  const warehouses = rows.map((r) => r.warehouse).sort()
  if (!warehouses.length) return

  const create = rawSchemas.get('order.create')
  if (create?.properties?.warehouseId) {
    create.properties.warehouseId.enum = warehouses
    // 编译产物也要同步，否则消解器拿到的还是旧列表
    tools.set('order.create', compile(create))
  }
  console.log(`🏭 仓库枚举已同步自数据库：${warehouses.join(' / ')}`)
}

await hydrateEnums()

console.log(`📐 已加载 ${tools.size} 个动词：${[...tools.keys()].join(', ')}`)
for (const [name, tool] of tools) {
  const req = tool.parameters.required.length
  const params = Object.keys(tool.parameters.properties).length
  console.log(`   ${name.padEnd(14)} ${tool.risk.padEnd(5)} 参数 ${params}（必填 ${req}）`)
}

// ---------------------------------------------------------------- Fastify

const app = Fastify({ logger: false })

app.get('/api/health', async () => ({
  ok: true,
  verbs: [...tools.keys()],
  agent:
    runtime.settings.provider === 'openai'
      ? `${runtime.settings.model} @ ${runtime.settings.baseUrl}`
      : 'rules（规则引擎，离线可跑）',
}))

// ---------------------------------------------------------------- 模型设置

/** 读当前配置（key 以掩码返回） */
app.get('/api/settings', async () => publicView(runtime.settings))

/** 保存配置 —— 立即生效，写入 .env.local，不进 git */
app.put<{ Body: Partial<LlmSettings> }>('/api/settings', async (req, reply) => {
  const b = req.body ?? {}
  const cur = runtime.settings

  // apiKey 传掩码（前端原样回传）表示「不改」
  const keyUnchanged = !b.apiKey || b.apiKey.includes('*')
  const next: LlmSettings = {
    provider: b.provider === 'openai' ? 'openai' : 'rules',
    baseUrl: (b.baseUrl ?? cur.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: keyUnchanged ? cur.apiKey : (b.apiKey ?? '').trim(),
    model: (b.model ?? cur.model).trim(),
    timeoutMs: Number(b.timeoutMs) > 0 ? Number(b.timeoutMs) : cur.timeoutMs,
  }

  if (next.provider === 'openai' && !next.apiKey) {
    return reply.code(400).send({ error: '切到模型模式必须先填 API Key' })
  }

  runtime.settings = saveSettings(next)
  return { ok: true, ...publicView(runtime.settings) }
})

/** 连通性测试 —— 真发一条最小请求，把服务端原始错误带回来（排查 401 用） */
app.post('/api/settings/test', async () => ping(runtime.settings))

/** 自省：这台系统能做什么 */
app.get('/api/verbs', async () =>
  listVerbs().map((v) => ({
    name: v.name,
    risk: v.risk,
    ...(rawSchemas.get(v.name)?.title ? { title: rawSchemas.get(v.name).title } : {}),
    params: Object.keys(tools.get(v.name)?.parameters.properties ?? {}),
    required: tools.get(v.name)?.parameters.required ?? [],
  }))
)

/** Formily Schema —— UI 拿去渲染表单 */
app.get<{ Params: { verb: string } }>('/api/schema/:verb', async (req, reply) => {
  const raw = rawSchemas.get(req.params.verb)
  if (!raw) return reply.code(404).send({ error: `未知动词：${req.params.verb}` })
  return raw
})

/** Tool Schema —— 模型拿去当工具定义（同一份 Schema 的另一个消费者） */
app.get<{ Params: { verb: string } }>('/api/tools/:verb', async (req, reply) => {
  const tool = tools.get(req.params.verb)
  if (!tool) return reply.code(404).send({ error: `未知动词：${req.params.verb}` })
  return tool
})

app.get('/api/tools', async () => Object.fromEntries(tools))

/** 实体选项：表单下拉框异步加载，不把数据写死进 Schema */
app.get<{ Params: { kind: string } }>('/api/entities/:kind', async (req, reply) => {
  const { kind } = req.params
  if (kind === 'customer') {
    const rows = await prisma.customer.findMany({ orderBy: { code: 'asc' } })
    return rows.map((c) => ({
      value: c.id,
      label: `${c.name}（${c.code}）`,
      hint: `${c.level} 级 · 额度 ¥${c.creditLimit.toLocaleString('zh-CN')}`,
    }))
  }
  if (kind === 'product') {
    const rows = await prisma.product.findMany({ orderBy: { model: 'asc' } })
    return rows.map((p) => ({
      value: p.id,
      label: `${p.model} ${p.name}`,
      hint: `牌价 ¥${p.price} / ${p.unit}`,
    }))
  }
  if (kind === 'warehouse') {
    const rows = await prisma.inventory.findMany({ distinct: ['warehouse'] })
    return [...new Set(rows.map((r) => r.warehouse))].map((w) => ({
      value: w,
      label: w,
    }))
  }
  return reply.code(404).send({ error: `未知实体：${kind}` })
})

// ---------------------------------------------------------------- 核心：一句话 → 意图 + 槽位

app.post<{ Body: { utterance?: string; today?: string } }>(
  '/api/interpret',
  async (req, reply) => {
    const utterance = req.body?.utterance?.trim()
    if (!utterance) {
      return reply.code(400).send({ error: 'utterance 不能为空' })
    }

    // 主数据词典：模型抽完之后同样要用它做实体链接校正
    const [customers, products] = await Promise.all([
      prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
      prisma.product.findMany({ select: { id: true, model: true, name: true } }),
    ])

    const result = await interpret(utterance, {
      tools,
      schemas: rawSchemas,
      ctx: {
        db: prisma,
        today: req.body?.today ? new Date(req.body.today) : new Date(),
      },
      dict: { customers, products },
      llm: runtime.settings,
      today: req.body?.today ? new Date(req.body.today) : new Date(),
    })

    // 客户确定后，才能推断仓库与单价（串行两步）
    const schemaDef = rawSchemas.get(result.verb)
    let slots = await hydrateInference(result.slots, schemaDef, { db: prisma })
    slots = await applyListPriceFallback(slots, schemaDef, { db: prisma })

    // 重新判定 ready / missing
    const tool = tools.get(result.verb)!
    const ambiguous = slots.filter((s) => s.candidates?.length)
    const missing = slots
      .filter((s) => s.value === null && tool.parameters.required.includes(s.slot))
      .map((s) => s.slot)

    let question: string | undefined
    if (ambiguous.length) {
      const a = ambiguous[0]
      question = `「${a.raw}」匹配到多个${a.title}，请选择一个：`
    } else if (missing.length) {
      const names = missing
        .map((m) => slots.find((s) => s.slot === m)?.title ?? m)
        .join('、')
      question = `还需要：${names}`
    }

    return {
      utterance,
      ...result,
      slots,
      missing,
      ...(question ? { question } : {}),
      ready: missing.length === 0 && ambiguous.length === 0,
    }
  }
)

// ---------------------------------------------------------------- 执行动词

app.post<{
  Params: { name: string }
  Body: {
    args?: Record<string, unknown>
    slots?: any[]
    supersedesId?: string
    sessionId?: string
  }
}>('/api/verbs/:name/run', async (req, reply) => {
  const verb = getVerb(req.params.name)
  if (!verb) {
    return reply.code(404).send({ error: `未知动词：${req.params.name}` })
  }

  const { __utterance, ...args } = (req.body?.args ?? {}) as Record<string, unknown>

  // 必填校验（Schema 层已声明，这里兜底）
  // 注意命名对齐：args 的 key 是「字段名」(customerId)，
  // 而 tool.parameters.required 是「槽位名」(customer) —— 必须用原始 Schema 的 required
  const rawSchema = rawSchemas.get(req.params.name)
  const missing = (rawSchema?.required ?? []).filter(
    (f: string) => args[f] === undefined || args[f] === null || args[f] === ''
  )
  if (missing.length) {
    return reply.code(400).send({ error: `缺少必填参数：${missing.join(', ')}` })
  }

  const result = await verb.run(args, { db: prisma, actor: 'owner' })

  // 落一格：不可变，提交即冻结
  const panel = await recordPanel(prisma, {
    sessionId: req.body?.sessionId,
    verb: req.params.name,
    title: rawSchema?.title,
    utterance: typeof __utterance === 'string' ? __utterance : null,
    slots: req.body?.slots,
    args,
    result,
    supersedesId: req.body?.supersedesId ?? null,
  })

  return { ...result, panelId: panel.id, panelSeq: panel.seq }
})

// ---------------------------------------------------------------- 画布

/** 取画布上的全部格子 */
app.get<{ Querystring: { sessionId?: string } }>('/api/panels', async (req) => {
  return listPanels(prisma, req.query.sessionId ?? 'default')
})

/** 从旧格开新格（修订）—— 返回预填好的槽位，不写库 */
app.post<{ Params: { id: string } }>('/api/panels/:id/revise', async (req, reply) => {
  const prep = await prepareRevision(prisma, req.params.id)
  if (!prep) return reply.code(404).send({ error: '格子不存在' })
  const schema = rawSchemas.get(prep.verb)
  return { ...prep, schema }
})

/** 按关联键取一条完整链路：这张单经历过什么 */
app.get<{ Params: { id: string } }>('/api/panels/:id/chain', async (req, reply) => {
  const panel = await prisma.panel.findUnique({ where: { id: req.params.id } })
  if (!panel?.correlationId) {
    return reply.code(404).send({ error: '该格子没有关联键' })
  }
  return getChain(prisma, panel.correlationId)
})

/**
 * 清空画布 —— 仅开发期使用。
 * 与「不可变」原则冲突，但 PoC 阶段反复测试需要重置。
 * 正式版应当移除，或改为「开一个新画布」而不是删记录。
 */
app.delete('/api/panels', async () => {
  const n = await prisma.panel.deleteMany({})
  return { deleted: n.count }
})

// ---------------------------------------------------------------- 静态资源（生产）

const distDir = join(ROOT, 'dist')
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, prefix: '/' })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}

// ---------------------------------------------------------------- 启动

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`\n🚀 AGT-ERP 服务已启动：http://localhost:${PORT}`)
  console.log(`   Agent 层：规则引擎（stub），W1 换成 Pi SDK + 本地 1.7B\n`)
} catch (err) {
  console.error('启动失败：', err)
  process.exit(1)
}
