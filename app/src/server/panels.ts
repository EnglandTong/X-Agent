/**
 * 画布格子服务层
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 铁律（Owner 决策）：**提交即冻结，永不原地修改。**                  │
 * │                                                                 │
 * │   要改 = 新开一格 → supersedesId 指向旧格 → 旧格标记 SUPERSEDED   │
 * │                                                                 │
 * │ 于是「改单」在库里的样子是：                                       │
 * │   #1 order.create  SO-2026-1012  ¥1,500   SUBMITTED             │
 * │   #2 order.create  SO-2026-1012  ¥1,800   SUBMITTED  ← 改的      │
 * │      （#1 被标记 SUPERSEDED，但内容一字未动，仍可完整回看）         │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 为什么值得这么做：
 *   1. 审计天然成立 —— 每一次改动都有前因后果，不需要额外的「操作日志表」
 *   2. 训练数据天然成立 —— 每格都带着「原话 → 抽取 → 落库」三元组
 *   3. 撤销天然成立 —— 回滚就是让上一格重新变成当前版本
 */

import type { PrismaClient } from '@prisma/client'
import type { SlotResult } from './agent'
import type { VerbResult } from './verbs/types'

// ---------------------------------------------------------------- 类型

/** 关联关键词：从主数据词典里识别出的实体，用来把散落的操作串起来 */
export interface LinkEntity {
  type: 'order' | 'customer' | 'product' | 'warehouse'
  value: string
  label: string
}

export interface RecordPanelInput {
  sessionId?: string
  verb: string
  title?: string
  utterance?: string | null
  slots?: SlotResult[]
  args?: Record<string, unknown>
  result?: VerbResult | null
  /** 修订链：本格替换了哪一格 */
  supersedesId?: string | null
  actor?: string
}

// ---------------------------------------------------------------- 关联键推导

/** 槽位名 → 关联实体类型 */
const ENTITY_SLOTS: Record<string, LinkEntity['type']> = {
  customer: 'customer',
  product: 'product',
  warehouse: 'warehouse',
  keyword: 'order',
}

/**
 * 推导关联键与关键词。
 *
 * correlationId 优先级：订单 > 客户。
 * 因为「这张单的所有操作」比「这个客户的所有操作」更常用、更具体。
 */
export function deriveLinkage(
  slots: SlotResult[] = [],
  result: VerbResult | null = null
): { correlationId: string | null; entities: LinkEntity[] } {
  const entities: LinkEntity[] = []

  for (const s of slots) {
    const type = ENTITY_SLOTS[s.slot]
    if (!type || s.value === null || s.value === undefined) continue
    entities.push({ type, value: String(s.value), label: s.label ?? String(s.value) })
  }

  // 执行结果里产生的订单号 —— 优先级最高
  const data = result?.data as any
  if (data?.no && result?.ok) {
    const no = String(data.no)
    entities.push({ type: 'order', value: data.id ? String(data.id) : no, label: no })

    // 变更单：把「原单号」也作为关键词记下来，这是串联两单的关键信息
    if (data.originNo) {
      entities.push({
        type: 'order',
        value: String(data.originNo),
        label: `原单 ${data.originNo}`,
      })
    }
    // correlationId 用变更链根单号 —— 同一条链上的所有单共享，整链可追溯
    const chain = data.chainId ? String(data.chainId) : no
    return { correlationId: `ORD:${chain}`, entities }
  }

  const order = entities.find((e) => e.type === 'order')
  if (order) return { correlationId: `ORD:${order.label}`, entities }

  const customer = entities.find((e) => e.type === 'customer')
  if (customer) return { correlationId: `CUS:${customer.value}`, entities }

  return { correlationId: null, entities }
}

// ---------------------------------------------------------------- 记录

export async function recordPanel(db: PrismaClient, input: RecordPanelInput) {
  const sessionId = input.sessionId ?? 'default'
  const { correlationId, entities } = deriveLinkage(input.slots, input.result ?? null)

  const seq =
    (await db.panel.count({ where: { sessionId } })) + 1

  // 先冻结旧格，再落新格 —— 顺序不能反，否则可能出现两格同时 ACTIVE
  if (input.supersedesId) {
    await db.panel.updateMany({
      where: { id: input.supersedesId, status: 'SUBMITTED' },
      data: { status: 'SUPERSEDED' },
    })
  }

  return db.panel.create({
    data: {
      seq,
      sessionId,
      verb: input.verb,
      title: input.title ?? input.verb,
      status: 'SUBMITTED',
      utterance: input.utterance ?? null,
      slots: input.slots ? JSON.stringify(input.slots) : null,
      args: input.args ? JSON.stringify(input.args) : null,
      result: input.result ? JSON.stringify(input.result) : null,
      ok: input.result?.ok ?? true,
      correlationId,
      entities: entities.length ? JSON.stringify(entities) : null,
      supersedesId: input.supersedesId ?? null,
      actor: input.actor ?? 'owner',
    },
  })
}

// ---------------------------------------------------------------- 查询

export async function listPanels(db: PrismaClient, sessionId = 'default') {
  const rows = await db.panel.findMany({
    where: { sessionId },
    orderBy: { seq: 'asc' },
  })
  const out = rows.map(deserialize)

  // 补上订单的**实时**状态。
  // 格子是冻结的快照，但订单此后可能已被确认 —— UI 必须按实时状态决定
  // 该给「修订」还是「变更」，否则会出现按钮点了却被服务端拒绝。
  for (const p of out) {
    const no = (p.result?.data as any)?.no
    if (p.verb === 'order.create' && no) {
      const live = await db.order.findFirst({ where: { no }, select: { status: true } })
      ;(p as any).liveStatus = live?.status ?? null
    }
  }
  return out
}

export function deserialize(row: any) {
  return {
    id: row.id,
    seq: row.seq,
    verb: row.verb,
    title: row.title,
    status: row.status,
    utterance: row.utterance,
    slots: row.slots ? JSON.parse(row.slots) : null,
    args: row.args ? JSON.parse(row.args) : null,
    result: row.result ? JSON.parse(row.result) : null,
    ok: row.ok,
    correlationId: row.correlationId,
    entities: row.entities ? JSON.parse(row.entities) : null,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt,
  }
}

/**
 * 从旧格开新格 —— 修订的起点。
 * 返回可以直接喂给确认页的东西：预填的 slots + 修订链信息。
 */
export async function prepareRevision(db: PrismaClient, panelId: string) {
  const old = await db.panel.findUnique({ where: { id: panelId } })
  if (!old) return null

  const oldSlots: SlotResult[] = old.slots ? JSON.parse(old.slots) : []
  const oldResult = old.result ? JSON.parse(old.result) : null

  // 关键：状态必须查实时值，不能信格子快照。
  // 格子是不可变的，它记录的是「建单那一刻」的状态；订单此后可能已被确认/出货。
  // 若用快照分流，会出现「UI 说能原地改、服务端却拒绝」的错位。
  let originStatus = (oldResult?.data?.statusRaw as string | undefined) ?? null
  const orderNo = (oldResult?.data?.no as string | undefined) ?? null
  if (orderNo) {
    const live = await db.order.findFirst({ where: { no: orderNo }, select: { status: true } })
    if (live) originStatus = live.status
  }

  return {
    supersedesId: old.id,
    verb: old.verb,
    title: old.title,
    // 旧值原样带回：推断出来的项仍标为「推断」，逼人复核，不会假装是你说的
    slots: oldSlots,
    correlationId: old.correlationId,
    utterance: old.utterance,
    /** 原地修订用：改哪张单（仅草稿可用） */
    orderId: (oldResult?.data?.id as string | undefined) ?? null,
    orderNo: (oldResult?.data?.no as string | undefined) ?? null,
    /** 变更单用：原单号 —— 业务关键字段，串联两单的关键词 */
    originNo: (oldResult?.data?.no as string | undefined) ?? null,
    /** 原单的**实时**状态：决定走「原地修订」还是「另开变更单」 */
    originStatus,
  }
}

/**
 * 按关联键取一条完整链路 —— 「这张单经历过什么」。
 */
export async function getChain(db: PrismaClient, correlationId: string) {
  const rows = await db.panel.findMany({
    where: { correlationId },
    orderBy: { seq: 'asc' },
  })
  return rows.map(deserialize)
}
