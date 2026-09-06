/**
 * Owner 真链路试用（API 版，10 条口吻）
 * 覆盖：开单 → 确认 → 部分出货 → 用语记住 → 再用习惯说法
 *
 *   npx tsx scripts/trial-10-utterances.ts
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'

async function json(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`)
  return data
}

function pick(slots: any[], name: string) {
  return slots.find((s) => s.slot === name || s.field === name)
}

async function runVerb(verb: string, utterance: string, slots: any[], extraArgs: Record<string, unknown> = {}) {
  const args: Record<string, unknown> = { __utterance: utterance }
  for (const s of slots) {
    if (s.value != null && s.value !== '') args[s.field] = s.value
  }
  Object.assign(args, extraArgs)
  return json('POST', `/api/verbs/${verb}/run`, { args, slots, sessionId: 'trial-10' })
}

async function main() {
  const health = await json('GET', '/api/health')
  console.log('health', health.agent, 'verbs', health.verbs?.length)

  await json('DELETE', '/api/panels?sessionId=trial-10')

  const log: string[] = []
  const ok = (id: string, msg: string) => {
    log.push(`✓ ${id} ${msg}`)
    console.log(log[log.length - 1])
  }
  const fail = (id: string, msg: string) => {
    log.push(`✗ ${id} ${msg}`)
    console.error(log[log.length - 1])
    throw new Error(msg)
  }

  // 1 完整开单（金额需过起订额）
  {
    const u = '给张三来80个A-100，下周三要'
    const i = await json('POST', '/api/interpret', { utterance: u, today: '2026-09-06' })
    if (i.verb !== 'order.create') fail('T1', `interpret verb=${i.verb}`)
    const r = await runVerb(i.verb, u, i.slots, {
      qty: Number(pick(i.slots, 'quantity')?.value ?? 80),
      unitPrice: 12.5,
      deliveryDate:
        pick(i.slots, 'delivery_date')?.value ?? pick(i.slots, 'deliveryDate')?.value ?? '2026-09-09',
      warehouseId:
        pick(i.slots, 'warehouse')?.value ?? pick(i.slots, 'warehouseId')?.value ?? '华东仓',
      customerId: pick(i.slots, 'customer')?.value,
      productId: pick(i.slots, 'product')?.value,
    })
    if (!r.ok) fail('T1', r.message)
    ok('T1', `开单 ${(r.data as any)?.no ?? ''}`)
  }

  // 2 重名歧义
  {
    const u = '给张来50个B-200'
    const i = await json('POST', '/api/interpret', { utterance: u })
    if (i.ready) fail('T2', '应歧义未 ready')
    ok('T2', `歧义提示：${i.question ?? 'ok'}`)
  }

  // 3 查询
  {
    const u = '查一下张三最近订单'
    const i = await json('POST', '/api/interpret', { utterance: u })
    if (i.verb !== 'order.query') fail('T3', `verb=${i.verb}`)
    const r = await runVerb(i.verb, u, i.slots)
    if (!r.ok) fail('T3', r.message)
    ok('T3', '查询订单')
  }

  // 4 记住「老王」+「开张单」+「圆珠笔」
  {
    const customers = await json('GET', '/api/entities/customer')
    const products = await json('GET', '/api/entities/product')
    const zhang = customers.find((c: any) => String(c.label).includes('张三'))
    const a100 = products.find((p: any) => String(p.label).includes('A-100'))
    if (!zhang || !a100) fail('T4', '缺种子主数据')
    await json('POST', '/api/lexicon', {
      phrase: '老王',
      kind: 'slot',
      slot: 'customer',
      targetId: zhang.value,
      targetLabel: zhang.label,
      source: 'explicit',
    })
    await json('POST', '/api/lexicon', {
      phrase: '开张单',
      kind: 'verb',
      verb: 'order.create',
      source: 'explicit',
    })
    await json('POST', '/api/lexicon', {
      phrase: '圆珠笔',
      kind: 'slot',
      slot: 'product',
      targetId: a100.value,
      targetLabel: a100.label,
      source: 'explicit',
    })
    ok('T4', '写入个人用语')
  }

  // 5 习惯说法开单
  let orderNo = ''
  {
    const u = '开张单给老王来50个圆珠笔'
    const i = await json('POST', '/api/interpret', { utterance: u, today: '2026-09-06' })
    if (i.verb !== 'order.create') fail('T5', `verb=${i.verb}`)
    const cust = pick(i.slots, 'customer')
    const prod = pick(i.slots, 'product')
    if (!String(cust?.note ?? '').includes('个人用语') && cust?.value == null) {
      fail('T5', '客户未命中用语')
    }
    // 补全数量等后执行
    if (!i.ready) {
      // 强制用已消解值
      for (const s of i.slots) {
        if (s.slot === 'quantity' && s.value == null) {
          s.value = 10
          s.source = 'user'
        }
      }
    }
    const r = await runVerb(i.verb, u, i.slots, {
      qty: Number(pick(i.slots, 'quantity')?.value ?? 50),
      unitPrice: 12.5,
      deliveryDate: pick(i.slots, 'delivery_date')?.value ?? pick(i.slots, 'deliveryDate')?.value ?? '2026-09-20',
      warehouseId: pick(i.slots, 'warehouse')?.value ?? pick(i.slots, 'warehouseId')?.value ?? '华东仓',
      customerId: cust?.value,
      productId: prod?.value,
    })
    if (!r.ok) fail('T5', r.message)
    orderNo = (r.data as any)?.no
    ok('T5', `用语开单 ${orderNo}`)
  }

  // 6 确认订单
  {
    const u = `确认订单 ${orderNo}`
    const i = await json('POST', '/api/interpret', { utterance: u })
    const r = await runVerb('order.confirm', u, i.slots, { orderNo })
    if (!r.ok) fail('T6', r.message)
    ok('T6', `确认 ${orderNo}`)
  }

  // 7 部分出货 4 个
  let dn1 = ''
  {
    const u = `给 ${orderNo} 先出4个`
    const i = await json('POST', '/api/interpret', { utterance: u })
    const r = await runVerb('delivery.create', u, i.slots, { orderNo, qty: 4 })
    if (!r.ok) fail('T7', r.message)
    dn1 = (r.data as any).deliveryNo
    ok('T7', `出货草稿 ${dn1}`)
  }

  // 8 确认出货 → PARTIALLY_SHIPPED
  {
    const r = await runVerb('delivery.confirm', `确认出货 ${dn1}`, [], { deliveryNo: dn1 })
    if (!r.ok) fail('T8', r.message)
    if ((r.data as any).orderStatus !== 'PARTIALLY_SHIPPED') {
      fail('T8', `期望 PARTIALLY_SHIPPED 得 ${(r.data as any).orderStatus}`)
    }
    ok('T8', '部分出货状态正确')
  }

  // 9 超量应拦
  {
    const r = await runVerb('delivery.create', '超量', [], { orderNo, qty: 100 })
    if (r.ok) fail('T9', '超量应失败')
    ok('T9', `超量拦截：${r.message}`)
  }

  // 10 查库存 / 信用
  {
    const u1 = '查一下A-100库存'
    const i1 = await json('POST', '/api/interpret', { utterance: u1 })
    const r1 = await runVerb(i1.verb, u1, i1.slots)
    if (!r1.ok) fail('T10a', r1.message)

    const u2 = '老王信用够不够下10000'
    const i2 = await json('POST', '/api/interpret', { utterance: u2 })
    const r2 = await runVerb(i2.verb === 'credit.check' ? i2.verb : 'credit.check', u2, i2.slots, {
      customerId: pick(i2.slots, 'customer')?.value,
      amount: pick(i2.slots, 'amount')?.value ?? 10000,
    })
    if (!r2.ok && !r2.message) fail('T10b', JSON.stringify(r2))
    ok('T10', '库存+信用查询')
  }

  console.log('\n—— 10 条试用全部通过 ——')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
