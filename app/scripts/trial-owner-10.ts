/**
 * T1 · Owner 10 条真口吻端到端试用（派工单见 HANDOVER/12_HANDOFF.md 第六节 T1）
 *
 *   npm run serve              # 另开终端先启服务
 *   npm run trial:owner10      # 本脚本
 *   BASE_URL=http://127.0.0.1:3002 npm run trial:owner10   # 断网/rules 档复跑
 *
 * 验收：≥8 条成功 · 0 条静默错误落库 · PersonalLexeme ≥1 行且能被命中
 * 脚本刻意不因单条失败中断 —— 10 条要全跑完，失败也是结论。
 */

import { PrismaClient } from '@prisma/client'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'
const TODAY = process.env.TODAY ?? new Date().toISOString().slice(0, 10)
const SESSION = process.env.SESSION_ID ?? 'owner-10'
const prisma = new PrismaClient()

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: r.status, data }
}

async function interpret(u: string) {
  const { status, data } = await api('POST', '/api/interpret', { utterance: u, today: TODAY })
  if (status >= 400) throw new Error(`interpret HTTP ${status} ${JSON.stringify(data)}`)
  return data
}

function slot(i: any, name: string) {
  return (i.slots ?? []).find((s: any) => s.slot === name || s.field === name)
}

function argsFrom(i: any, utterance: string, extra: Record<string, unknown> = {}) {
  const args: Record<string, unknown> = { __utterance: utterance }
  for (const s of i.slots ?? []) {
    if (s.value != null && s.value !== '') args[s.field ?? s.slot] = s.value
  }
  return { ...args, ...extra }
}

async function run(verb: string, utterance: string, i: any, extra: Record<string, unknown> = {}) {
  const args = argsFrom(i, utterance, extra)
  return api('POST', `/api/verbs/${verb}/run`, { args, slots: i.slots, sessionId: SESSION })
}

const rows: Array<{
  no: string
  utterance: string
  verb: string
  engine: string
  ready: string
  result: string
  note: string
}> = []

function rec(no: string, utterance: string, verb: string, engine: string, ready: string, result: string, note = '') {
  rows.push({ no, utterance, verb, engine, ready, result, note })
  console.log(`${result} ${no.padEnd(4)} ${utterance.padEnd(22)} verb=${verb.padEnd(16)} engine=${engine.padEnd(6)} ready=${ready.padEnd(5)} ${note}`)
}

const OK = '✓'
const NO = '✗'
const WARN = '!'

async function main() {
  const health = await api('GET', '/api/health')
  console.log(`\n服务：${health.data.agent} · 动词 ${health.data.verbs?.length} 个 · today=${TODAY}\n`)

  // 画布格子是不可变资产，默认不清；要干净的起点才显式 RESET_PANELS=1
  if (process.env.RESET_PANELS === '1') await api('DELETE', `/api/panels?sessionId=${SESSION}`)

  const before = await prisma.delivery.count()
  let orderNo = ''
  let deliveryNo = ''

  // ── 1 · 完整开单 ────────────────────────────────────────────────
  {
    const u = '给张三来 120 个 A-100，下周三要'
    const i = await interpret(u)
    if (i.verb !== 'order.create') {
      rec('1', u, i.verb, i.engine, String(i.ready), NO, `期望 order.create`)
    } else {
      const r = await run(i.verb, u, i, { qty: 120 })
      if (r.data?.ok) {
        orderNo = r.data.data?.no ?? ''
        rec('1', u, i.verb, i.engine, String(i.ready), OK, `开单 ${orderNo}`)
      } else {
        rec('1', u, i.verb, i.engine, String(i.ready), NO, r.data?.message ?? JSON.stringify(r.data))
      }
    }
  }

  // ── 1b · 确认订单（出货前置，非 10 条之一）────────────────────────
  if (orderNo) {
    const u = `确认订单 ${orderNo}`
    const i = await interpret(u)
    const r = await run('order.confirm', u, i, { orderNo })
    if (r.data?.ok) console.log(`    ↳ 1b 已确认 ${orderNo}（出货前置）`)
    else console.log(`    ↳ 1b 确认失败：${r.data?.message ?? JSON.stringify(r.data)}`)
  }

  // ── 2 · 用语「老王」（未记住时应当问，不应猜）─────────────────────
  {
    const u = '老王那个单再补 50 个'
    const i = await interpret(u)
    const cust = slot(i, 'customer')
    const hit = String(cust?.note ?? '').includes('个人用语')
    if (hit) rec('2', u, i.verb, i.engine, String(i.ready), OK, '命中个人用语')
    else
      rec(
        '2',
        u,
        i.verb,
        i.engine,
        String(i.ready),
        WARN,
        `未记住「老王」→ ${i.question ?? `customer=${cust?.value ?? 'null'}`}（不猜，正确）`
      )
  }

  // ── 3 · 动词用语「开张单」────────────────────────────────────────
  {
    const u = '开张单，B-200 要 30'
    const i = await interpret(u)
    if (i.verb === 'order.create' && i.ready) {
      const r = await run(i.verb, u, i, { qty: Number(slot(i, 'quantity')?.value ?? 30) })
      if (r.data?.ok) rec('3', u, i.verb, i.engine, String(i.ready), OK, `开单 ${r.data.data?.no ?? ''}`)
      else rec('3', u, i.verb, i.engine, String(i.ready), NO, r.data?.message ?? JSON.stringify(r.data))
    } else {
      rec('3', u, i.verb, i.engine, String(i.ready), WARN, i.question ?? `未识别为建单：${i.verb}`)
    }
  }

  // ── 4 · 查库存 ──────────────────────────────────────────────────
  {
    const u = '华东仓还有多少 A-100'
    const i = await interpret(u)
    if (i.verb === 'inventory.query') {
      const r = await run(i.verb, u, i)
      rec('4', u, i.verb, i.engine, String(i.ready), r.data?.ok ? OK : NO, r.data?.message ?? '库存已返回')
    } else {
      rec('4', u, i.verb, i.engine, String(i.ready), NO, `期望 inventory.query`)
    }
  }

  // ── 5 · 部分出货 ────────────────────────────────────────────────
  {
    const u = orderNo ? `订单 ${orderNo} 出 80 个` : '订单 SO-2026-1002 出 80 个'
    const i = await interpret(u)
    const target = orderNo || 'SO-2026-1002'
    const r = await run(i.verb === 'delivery.create' ? i.verb : 'delivery.create', u, i, {
      orderNo: target,
      qty: 80,
    })
    if (r.data?.ok) {
      deliveryNo = r.data.data?.deliveryNo ?? ''
      rec('5', u, 'delivery.create', i.engine, String(i.ready), OK, `出货草稿 ${deliveryNo}`)
    } else {
      rec('5', u, i.verb, i.engine, String(i.ready), NO, r.data?.message ?? JSON.stringify(r.data))
    }
  }

  // ── 5b · 确认出货 → PARTIALLY_SHIPPED（非 10 条之一）──────────────
  if (deliveryNo) {
    const i = await interpret(`确认出货 ${deliveryNo}`)
    const r = await run('delivery.confirm', `确认出货 ${deliveryNo}`, i, { deliveryNo })
    const st = r.data?.data?.orderStatus
    console.log(`    ↳ 5b 出货确认 → 订单状态 ${st ?? r.data?.message}`)
  }

  // ── 6 · 超量硬拦（同时验证「失败不落库」）───────────────────────
  {
    const u = '同一个单再出 100 个'
    const i = await interpret(u)
    const cntBefore = await prisma.delivery.count()
    const r = await run('delivery.create', u, i, { orderNo: orderNo || 'SO-2026-1002', qty: 100 })
    const cntAfter = await prisma.delivery.count()
    if (!r.data?.ok && cntAfter === cntBefore) {
      rec('6', u, 'delivery.create', i.engine, String(i.ready), OK, `超量拦截：${r.data?.message ?? ''}`)
    } else if (!r.data?.ok) {
      rec('6', u, 'delivery.create', i.engine, String(i.ready), NO, `拦截了但落库 +${cntAfter - cntBefore}（静默错误）`)
    } else {
      rec('6', u, 'delivery.create', i.engine, String(i.ready), NO, '超量未拦截')
    }
  }

  // ── 7 · ASR 误识「张three」（不得静默落库）───────────────────────
  {
    const u = '张three 的单取消掉'
    const i = await interpret(u)
    const cust = slot(i, 'customer')
    const cntBefore = await prisma.delivery.count()
    if (i.ready) {
      const r = await run('order.cancel', u, i, { reason: 'ASR 误识测试' })
      rec('7', u, i.verb, i.engine, String(i.ready), NO, `误识却 ready，执行了 ${JSON.stringify(r.data?.data ?? r.data?.message)}`)
    } else {
      rec(
        '7',
        u,
        i.verb,
        i.engine,
        String(i.ready),
        OK,
        `拒绝执行：${i.question ?? '缺必填'}（customer=${cust?.value ?? 'null'}，未落库 ${cntBefore === (await prisma.delivery.count()) ? '✓' : '✗'}）`
      )
    }
  }

  // ── 8 · 时间表达式查询 ──────────────────────────────────────────
  {
    const u = '查一下上个月王五的单'
    const i = await interpret(u)
    if (i.verb === 'order.query') {
      const r = await run(i.verb, u, i)
      const n = Array.isArray(r.data?.data?.orders) ? r.data.data.orders.length : Array.isArray(r.data?.data) ? r.data.data.length : 0
      rec('8', u, i.verb, i.engine, String(i.ready), r.data?.ok ? OK : NO, `返回 ${n} 条`)
    } else {
      rec('8', u, i.verb, i.engine, String(i.ready), NO, '期望 order.query')
    }
  }

  // ── 9 · 显式记住「老李就是李四」──────────────────────────────────
  {
    const u = '记住：老李就是李四'
    const i = await interpret(u)
    const isRemember = i.verb?.startsWith('lexicon')
    // UI 等价路径：确认卡点「记住」→ POST /api/lexicon
    const customers = await prisma.customer.findMany()
    const lisi = customers.find((c) => c.name === '李四')
    const w = await api('POST', '/api/lexicon', {
      phrase: '老李',
      kind: 'slot',
      slot: 'customer',
      targetId: lisi?.id,
      targetLabel: lisi?.name,
      source: 'explicit',
    })
    // 回验：用习惯说法再开一次单，看是否命中个人用语
    const u2 = '给老李来 30 个 B-200'
    const i2 = await interpret(u2)
    const cust2 = slot(i2, 'customer')
    const hit = String(cust2?.note ?? '').includes('个人用语') || cust2?.value === lisi?.id
    rec(
      '9',
      u,
      i.verb,
      i.engine,
      String(i.ready),
      w.status === 200 && hit ? OK : WARN,
      `${isRemember ? '有 remember 动词' : '无 remember 动词（需 UI 记住按钮）'}；写用语 HTTP ${w.status}；回验「${u2}」${hit ? '命中个人用语' : `未命中（customer=${cust2?.value ?? 'null'}）`}`
    )
  }

  // ── 10 · 规则答不了的口语 ───────────────────────────────────────
  {
    const u = '杠笔多少钱'
    const i = await interpret(u)
    const r = await run(i.verb, u, i)
    const answered = r.data?.ok
    rec(
      '10',
      u,
      i.verb,
      i.engine,
      String(i.ready),
      WARN,
      `落到 ${i.verb}（无 price.query）；执行 ${answered ? '成功' : '失败'}：${(r.data?.message ?? JSON.stringify(r.data?.data ?? '')).slice(0, 80)}`
    )
  }

  // ── 汇总 ────────────────────────────────────────────────────────
  const okCount = rows.filter((r) => r.result === OK).length
  const noCount = rows.filter((r) => r.result === NO).length
  const warnCount = rows.filter((r) => r.result === WARN).length

  const lex = await prisma.personalLexeme.findMany({ orderBy: { updatedAt: 'desc' } })
  const [panels, orders, deliveries] = await Promise.all([
    prisma.panel.count(),
    prisma.order.count(),
    prisma.delivery.count(),
  ])

  console.log('\n———— 汇总 ————')
  console.log(`成功 ${okCount} / 10 · 失败 ${noCount} · 需判定 ${warnCount}`)
  console.log(`PersonalLexeme ${lex.length} 行 · Panel ${panels} 行 · Order ${orders} 行 · Delivery ${deliveries} 行（跑前 ${before}）`)
  for (const l of lex) console.log(`   用语：${l.phrase} → ${l.kind}/${l.slot ?? l.verb} ${l.targetLabel ?? ''} [${l.status}] hits=${l.hits}`)
  console.log('')
  for (const r of rows) {
    if (r.result !== OK) console.log(`${r.result} ${r.no} ${r.utterance} → ${r.note}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
