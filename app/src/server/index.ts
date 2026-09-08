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
 *   POST /api/asr                一段 16k WAV 原始字节 → 文本（「耳」，本地 SenseVoice）
 *   GET  /api/asr/status         耳朵状态（是否支持 / 权重在不在 / 模型加载态）
 *   GET  /api/entities/:kind     实体选项（供表单下拉框异步加载）
 */

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { PrismaClient } from '@prisma/client'
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile, loadVerbs } from './compile'
import { getVerb, listVerbs } from './verbs/registry'
import { interpret, hydrateInference, applyListPriceFallback } from './agent'
import { ping } from './llm'
import { loadSettings, saveSettings, publicView, type LlmSettings } from './settings'
import { speak, isTtsSupported } from './speak'
import { transcribeFromWav, asrStatus, warmAsr, isAsrSupported } from './asr'
import {
  recordPanel,
  listPanels,
  listSessions,
  clearSession,
  prepareRevision,
  getChain,
} from './panels'
import {
  listLexemes,
  upsertLexeme,
  rejectLexeme,
  retireLexeme,
  proposeFromConfirm,
  isStandardTerm,
  observeUsage,
} from './lexicon'

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

for (const fileName of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'))) {
  const file = join(SCHEMA_DIR, fileName)
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  const verb = raw['x-verb'] ?? fileName.replace(/\.json$/, '')
  rawSchemas.set(verb, raw)
  tools.set(verb, compile(raw as any))
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

  for (const [verb, raw] of rawSchemas) {
    if (raw?.properties?.warehouseId) {
      raw.properties.warehouseId.enum = warehouses
      tools.set(verb, compile(raw as any))
    }
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

/**
 * bodyLimit 2MiB —— 给「耳」的一段 16k WAV 腾位置（32,000 B/s ⇒ 2MiB ≈ 65s）。
 * Fastify v5 **没有 per-route bodyLimit**，只能全局抬；域内的 15s 上限在
 * `asr.ts` 里判，这样超长回的是可读的 `too_long`，而不是裸 413。
 */
const app = Fastify({ logger: false, bodyLimit: 2_097_152 })

/**
 * 全仓第一个非 JSON body：`/api/asr` 收原始 WAV 字节。
 * 选二进制而不是 base64-JSON：省 33% 字节、免两端编解码，而且
 * `curl --data-binary @x.wav -H 'Content-Type: application/octet-stream'` 能直接手工验证。
 * 走 multipart 才需要新插件 —— 这里不需要。
 */
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body)
)

app.get('/api/health', async () => ({
  ok: true,
  verbs: [...tools.keys()],
  agent:
    runtime.settings.provider === 'openai'
      ? `${runtime.settings.model} @ ${runtime.settings.baseUrl}`
      : 'rules（规则引擎，离线可跑）',
}))

// ---------------------------------------------------------------- 模型设置

/**
 * 设置视图 = 掩码配置 + 耳朵状态。
 * `asr` 在这里组合、而不是塞进 `publicView`：方向只能是 index.ts → { settings, asr }，
 * `asr.ts` 反向 import `settings.ts` 会成环。
 */
const settingsView = () => ({ ...publicView(runtime.settings), asr: asrStatus() })

/** 读当前配置（key 以掩码返回） */
app.get('/api/settings', async () => settingsView())

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
    // 语音播报开关（「嘴」）；不传表示不改
    ttsEnabled: typeof b.ttsEnabled === 'boolean' ? b.ttsEnabled : cur.ttsEnabled,
    // 语音识别引擎（「耳」）；白名单回落，别写成 `b.asrEngine ?? cur` —— 空串会漏进来
    asrEngine: b.asrEngine === 'local' || b.asrEngine === 'browser' ? b.asrEngine : cur.asrEngine,
  }

  if (next.provider === 'openai' && !next.apiKey) {
    return reply.code(400).send({ error: '切到模型模式必须先填 API Key' })
  }

  runtime.settings = saveSettings(next)
  // 刚从浏览器切到本地 → 后台预热。绝不 await：加载要 1.1s，不能拖住这次保存
  if (next.asrEngine === 'local' && cur.asrEngine !== 'local') void warmAsr()
  return { ok: true, ...settingsView() }
})

/** 连通性测试 —— 真发一条最小请求，把服务端原始错误带回来（排查 401 用） */
app.post('/api/settings/test', async () => ping(runtime.settings))

// ---------------------------------------------------------------- 「嘴」· 语音播报

/**
 * POST /api/speak { text }
 *
 * 画布在执行完动词、或还有字段没问到时调用它 —— 让系统第一次主动开口。
 * 播报失败只降级（服务端打印文本），绝不冒泡成错误：嘴缺位不能影响业务。
 */
app.post<{ Body: { text?: string } }>('/api/speak', async (req, reply) => {
  const text = (req.body?.text ?? '').trim()
  if (!text) return reply.code(400).send({ error: 'text 不能为空' })
  if (!runtime.settings.ttsEnabled) {
    return { ok: false, skipped: 'disabled', reason: '语音播报已关闭（设置面板可开）' }
  }
  const r = await speak(text)
  return { ...r, skipped: r.ok ? undefined : r.reason, supported: isTtsSupported() }
})

// ---------------------------------------------------------------- 「耳」· 语音识别

/**
 * POST /api/asr —— 一段 16k 单声道 WAV 的**原始字节** → 文本。
 *
 * 只有「语音引擎 = 本地」时画布才打这里；引擎是浏览器时直接回 skipped，模型根本不加载。
 * 降级纪律与「嘴」一致（speak.ts:9）：能力缺失 / 权重没装 / 还在加载 一律 200 + ok:false，
 * 绝不冒泡成 5xx —— 耳朵缺位不能影响业务。
 */
app.post('/api/asr', async (req, reply) => {
  const body = req.body as unknown
  if (!(body instanceof Uint8Array) || body.byteLength === 0) {
    return reply
      .code(400)
      .send({ error: 'body 必须是 WAV 原始字节（Content-Type: application/octet-stream）' })
  }
  if (runtime.settings.asrEngine !== 'local') {
    return {
      ok: false,
      text: '',
      skipped: 'disabled',
      reason: '语音识别当前用浏览器引擎（设置面板可切本地）',
      supported: isAsrSupported(),
    }
  }
  const r = await transcribeFromWav(body)
  return { ...r, skipped: r.ok ? undefined : r.reason, supported: isAsrSupported() }
})

/** GET /api/asr/status —— 只读：平台支持吗 / 权重在吗 / 加载到哪一步 */
app.get('/api/asr/status', async () => asrStatus())

/**
 * POST /api/asr/warm —— 预热或重试加载（failed 只有这条路能再来一次）。
 * 存在的意义：装完 228MB 权重后不必重启服务，设置面板点一下即可。
 */
app.post('/api/asr/warm', async () => warmAsr())

/** 真人语料目录：画布「存为语料」的落点，gitignore 掉（含人声，不该入库） */
const CORPUS_DIR = join(ROOT, 'eval', 'asr-wavs-real')
/** id 白名单：本身就排除了 `/`、`\`、`..` 与任何分隔符 */
const CORPUS_ID = /^[A-Za-z0-9_-]{1,40}$/

/**
 * PUT /api/asr/corpus/:id —— 存一段真人录音，补上「34% 来自 SAPI 合成语音、
 * 真人从没测过」这个缺口。落盘后同一段字节能在浏览器外被 `curl --data-binary`
 * 复现，并被 `npm run asr:cer` 自动优先采用（同名覆盖合成音频）。
 *
 * 服务默认听 0.0.0.0，这是个局域网可达的**写入**端点，所以校验逐条来：
 *   1. id 严格白名单正则 2. resolve 后断言仍在基目录内（纵深防御）
 *   3. 基目录硬编码，不接受前端传路径 4. 只认 RIFF 头 5. 默认拒覆盖，要 ?overwrite=1
 */
app.put<{ Params: { id: string }; Querystring: { overwrite?: string } }>(
  '/api/asr/corpus/:id',
  async (req, reply) => {
    const { id } = req.params
    if (!CORPUS_ID.test(id)) {
      return reply.code(400).send({ error: 'id 只允许字母、数字、_、-，最长 40 字符' })
    }
    const body = req.body as unknown
    if (!(body instanceof Uint8Array) || body.byteLength < 44) {
      return reply.code(400).send({ error: 'body 必须是一段 WAV 原始字节' })
    }
    if (body[0] !== 0x52 || body[1] !== 0x49 || body[2] !== 0x46 || body[3] !== 0x46) {
      return reply.code(400).send({ error: '只收 WAV（前 4 字节必须是 RIFF）' })
    }

    const base = resolve(CORPUS_DIR)
    const target = resolve(base, `${id}.wav`)
    if (!target.startsWith(base + sep)) {
      return reply.code(400).send({ error: '路径越界' })
    }
    if (existsSync(target) && req.query.overwrite !== '1') {
      return reply.code(409).send({ error: `${id}.wav 已存在（要覆盖请带 ?overwrite=1）` })
    }

    mkdirSync(base, { recursive: true })
    writeFileSync(target, body)
    return { ok: true, id, bytes: body.byteLength, path: relative(ROOT, target) }
  }
)

// ---------------------------------------------------------------- 个人用语表

app.get<{ Querystring: { userId?: string; status?: string } }>('/api/lexicon', async (req) => {
  const userId = req.query.userId ?? 'owner'
  const status = req.query.status as 'active' | 'rejected' | 'retired' | undefined
  return listLexemes(prisma, userId, status)
})

app.post<{
  Body: {
    phrase?: string
    kind?: 'verb' | 'slot'
    verb?: string
    slot?: string
    targetId?: string
    targetLabel?: string
    targetRaw?: string
    source?: 'explicit' | 'confirmed'
    userId?: string
    status?: 'active' | 'rejected' | 'retired'
  }
}>('/api/lexicon', async (req, reply) => {
  const b = req.body ?? {}
  if (!b.phrase?.trim() || !b.kind) {
    return reply.code(400).send({ error: 'phrase 与 kind 必填' })
  }
  // 标准名不入库：系统本来就认得，记了只会污染词表。
  // 返回 200 + skipped（不是错误）—— 前端必须能把「为什么不记」说清楚，否则又变成「点了没反应」。
  if (b.kind === 'slot' && b.slot && (await isStandardTerm(prisma, b.phrase, b.slot))) {
    return {
      ok: false,
      skipped: 'standard_term',
      reason: `「${b.phrase.trim()}」本来就是标准名，系统本来就认得，不用记`,
    }
  }
  try {
    const row = await upsertLexeme(prisma, {
      phrase: b.phrase,
      kind: b.kind,
      verb: b.verb,
      slot: b.slot,
      targetId: b.targetId,
      targetLabel: b.targetLabel,
      targetRaw: b.targetRaw,
      source: b.source === 'confirmed' ? 'confirmed' : 'explicit',
      userId: b.userId ?? 'owner',
      status: b.status === 'rejected' ? 'rejected' : 'active',
    })
    return { ok: true, lexeme: row }
  } catch (e: any) {
    return reply.code(400).send({ error: String(e?.message ?? e) })
  }
})

app.post<{ Params: { id: string } }>('/api/lexicon/:id/reject', async (req, reply) => {
  try {
    const row = await rejectLexeme(prisma, req.params.id)
    return { ok: true, lexeme: row }
  } catch {
    return reply.code(404).send({ error: '用语不存在' })
  }
})

app.delete<{ Params: { id: string } }>('/api/lexicon/:id', async (req, reply) => {
  try {
    const row = await retireLexeme(prisma, req.params.id)
    return { ok: true, lexeme: row }
  } catch {
    return reply.code(404).send({ error: '用语不存在' })
  }
})

/** 根据确认结果生成「是否记住」提议（不入库） */
app.post<{
  Body: {
    utterance?: string
    verb?: string
    slots?: any[]
    submittedValues?: Record<string, unknown>
  }
}>('/api/lexicon/propose', async (req) => {
  const b = req.body ?? {}
  const proposals = await proposeFromConfirm(prisma, {
    utterance: b.utterance ?? '',
    verb: b.verb ?? '',
    slots: b.slots ?? [],
    submittedValues: b.submittedValues ?? {},
  })
  return { proposals }
})

/** 自省：这台系统能做什么 */
app.get('/api/verbs', async () =>
  listVerbs().map((v) => ({
    name: v.name,
    risk: v.risk,
    ...(rawSchemas.get(v.name)?.title ? { title: rawSchemas.get(v.name)!.title } : {}),
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
    } else if (result.verbConfidence < 0.75 && result.risk === 'read') {
      // D11：低置信只读 —— 宁可承认不确定，也不要自信地答非所问（G2：
      // 断网档曾把「杠笔多少钱」当订单查询执行并报出合计金额）
      question = `这个我不太确定（把握 ${Math.round(result.verbConfidence * 100)}%，判为「${result.verb}」）—— 可以换个说法，也可以直接确认执行。`
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
  const hasItems = Array.isArray(args.items) && (args.items as unknown[]).length > 0
  const missing = (rawSchema?.required ?? []).filter((f: string) => {
    if (hasItems && (f === 'productId' || f === 'qty' || f === 'unitPrice')) return false
    return args[f] === undefined || args[f] === null || args[f] === ''
  })
  if (missing.length) {
    return reply.code(400).send({ error: `缺少必填参数：${missing.join(', ')}` })
  }

  const result = await verb.run(args, { db: prisma, actor: 'owner' })

  // 记忆：观察一次「说法 → 目标」（决策 #28）
  //   先进候选区，跨 ≥2 天才升格为记忆卡；标准名与异常情况一律跳过。
  //   观察失败绝不影响主流程 —— 记忆是增益，不是主链路的一环。
  if ((result as { ok?: boolean })?.ok) {
    for (const s of req.body?.slots ?? []) {
      if (s?.slot !== 'customer' && s?.slot !== 'product') continue
      const raw = s.raw != null ? String(s.raw).trim() : ''
      const targetId = (args as Record<string, unknown>)[s.field]
      if (!raw || raw.length < 2 || targetId == null || targetId === '') continue
      await observeUsage(prisma, {
        phrase: raw,
        slot: s.slot,
        targetId: String(targetId),
        targetLabel: s.label ?? null,
        source: 'observed',
      }).catch(() => {})
    }
  }

  // 落一格：不可变，提交即冻结
  const panel = await recordPanel(prisma, {
    sessionId: req.body?.sessionId ?? 'default',
    verb: req.params.name,
    title: rawSchema?.title,
    utterance: typeof __utterance === 'string' ? __utterance : null,
    slots: req.body?.slots,
    args,
    result,
    supersedesId: req.body?.supersedesId ?? null,
  })

  return { ...result, panelId: panel.id, panelSeq: panel.seq, sessionId: panel.sessionId }
})

// ---------------------------------------------------------------- 画布

/** 工作页列表（Tab）—— 每个 session 是一条独立工作链 */
app.get('/api/sessions', async () => listSessions(prisma))

/** 取画布上的全部格子（按当前工作页） */
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
 * 清空当前工作页的格子。
 * 不传 sessionId 时只清 default；不会误删其它 Tab。
 */
app.delete<{ Querystring: { sessionId?: string } }>('/api/panels', async (req) => {
  const sessionId = req.query.sessionId ?? 'default'
  const deleted = await clearSession(prisma, sessionId)
  return { deleted, sessionId }
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
  console.log(`   动词 ${tools.size} 个 · Agent：${runtime.settings.provider}\n`)
  // 耳朵预热放在端口之后：模型加载实测 1.1s / +303MiB，挡在关键路径上等于整站晚 1 秒。
  // 引擎=browser 时根本不碰模型（零内存）—— 这就是默认的零感知回退位。
  if (runtime.settings.asrEngine === 'local') void warmAsr().catch(() => {})
} catch (err) {
  console.error('启动失败：', err)
  process.exit(1)
}
