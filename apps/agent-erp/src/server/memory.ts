/**
 * 记忆网络 v2 —— 共现派生 + 升格通知（决策 #28 / C 项）
 *
 * 不新建图存储：边从 Panel.entities JSON 两两派生；升格通知由 observeUsage.promoted 带出。
 */

import type { PrismaClient } from '@prisma/client'

export interface MemoryNotice {
  phrase: string
  slot: string
  targetId: string
  targetLabel: string | null
  days: number
  /** 给人看的一句：我注意到你常说「X」——已记为 Y */
  message: string
}

export function formatPromoteNotice(input: {
  phrase: string
  targetLabel?: string | null
  days: number
}): string {
  const label = input.targetLabel?.trim() || '对应实体'
  return `我注意到你常说「${input.phrase}」——已记为 ${label}（跨 ${input.days} 天升格）`
}

export interface CooccurNode {
  type: string
  value: string
  label: string
}

export interface CooccurEdge {
  a: CooccurNode
  b: CooccurNode
  /** 同格共现次数 */
  count: number
  /** 最近一次共现的 panel id */
  lastPanelId: string
}

interface EntityJson {
  type: string
  value: string
  label: string
}

function nodeKey(n: { type: string; value: string }): string {
  return `${n.type}:${n.value}`
}

/**
 * 从 Panel.entities 派生共现边（同一格内实体两两相连）。
 * SQL 已在评审里验证过思路；实现用 JS 解析 JSON，避免绑死 SQLite json1。
 */
export async function cooccurFromPanels(
  db: PrismaClient,
  opts: { minCount?: number; limit?: number; sessionId?: string } = {}
): Promise<{ nodes: CooccurNode[]; edges: CooccurEdge[]; panelCount: number }> {
  const minCount = Math.max(1, opts.minCount ?? 2)
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30))

  const panels = await db.panel.findMany({
    where: {
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      entities: { not: null },
    },
    select: { id: true, entities: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  const edgeMap = new Map<string, CooccurEdge>()
  const nodeMap = new Map<string, CooccurNode>()

  for (const p of panels) {
    let list: EntityJson[] = []
    try {
      list = JSON.parse(p.entities ?? '[]') as EntityJson[]
    } catch {
      continue
    }
    if (!Array.isArray(list) || list.length < 2) continue

    // 去重：同一格同一实体只算一次
    const uniq = new Map<string, EntityJson>()
    for (const e of list) {
      if (!e?.type || e.value == null) continue
      const n: CooccurNode = {
        type: String(e.type),
        value: String(e.value),
        label: String(e.label ?? e.value),
      }
      uniq.set(nodeKey(n), e)
      nodeMap.set(nodeKey(n), n)
    }
    const arr = [...uniq.values()].map((e) => ({
      type: String(e.type),
      value: String(e.value),
      label: String(e.label ?? e.value),
    }))
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const left = arr[i]
        const right = arr[j]
        // 稳定排序，避免 A-B / B-A 分裂
        const [a, b] =
          nodeKey(left) < nodeKey(right) ? [left, right] : [right, left]
        const ek = `${nodeKey(a)}|${nodeKey(b)}`
        const prev = edgeMap.get(ek)
        if (prev) {
          prev.count += 1
          prev.lastPanelId = p.id
        } else {
          edgeMap.set(ek, { a, b, count: 1, lastPanelId: p.id })
        }
      }
    }
  }

  const edges = [...edgeMap.values()]
    .filter((e) => e.count >= minCount)
    .sort((x, y) => y.count - x.count || nodeKey(x.a).localeCompare(nodeKey(y.a)))
    .slice(0, limit)

  // 节点只保留出现在边上的
  const used = new Set<string>()
  for (const e of edges) {
    used.add(nodeKey(e.a))
    used.add(nodeKey(e.b))
  }
  const nodes = [...used].map((k) => nodeMap.get(k)!).filter(Boolean)

  return { nodes, edges, panelCount: panels.length }
}
