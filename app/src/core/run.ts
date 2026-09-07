/**
 * Run —— 一次任务从「听到」到「落库」的完整生命周期。
 *
 * 为什么要有它：审计、回放、评测都需要**同一个**数据源。
 * 现在这个源头是 `Panel`（画布格子）；将来主干接更多应用时，Run 是它之上的统一抽象。
 *
 * ⚠️ 本文件**只有类型与纯函数**，不依赖数据库、HTTP 或任何 server 代码。
 *    铁律（T5）：`core/` 不得 import `server/` —— 单向依赖，将来才能整体搬走。
 */

/** 六态：一次任务只会处于其中一种 */
export type RunState =
  /** 收到原始输入（text / audio 等任意 modality 的 Observation） */
  | 'received'
  /** 已产出动词 + 槽位（可能缺字段，也可能有候选待选） */
  | 'interpreted'
  /** 等人确认 —— 写操作必经此态；只读可直接跳过 */
  | 'awaiting'
  /** 已执行并落库（此后不可变） */
  | 'executed'
  /** 被业务规则 / 必填校验拦下，未落库（ok:false 也算这里） */
  | 'blocked'
  /** 人取消，或超时未确认 */
  | 'abandoned'

/** 合法转移。任何不在这个表里的跳转都是 bug。 */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  received: ['interpreted', 'abandoned'],
  interpreted: ['awaiting', 'executed', 'blocked', 'abandoned'],
  awaiting: ['executed', 'blocked', 'abandoned'],
  executed: [], // 终态：落库即冻结，不可再改
  blocked: [], // 终态：要再试就开新的 Run
  abandoned: [], // 终态
}

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/** 终态 = 不会再变（审计口径：这些态可以归档） */
export function isTerminal(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0
}

/**
 * 一次任务的最小记录。
 * 字段名刻意保持与未来主干一致（主干的 Run 就是它），Agent_ERP 侧由 Panel 提供数据。
 */
export interface Run<TPayload = unknown> {
  /** 本次 Run 的唯一标识（Agent_ERP 里对应 Panel.id） */
  id: string
  /** 命中的能力名（= 动词名，如 order.create） */
  capability: string
  state: RunState
  /** 原始输入（人说的那句话） */
  utterance?: string | null
  /** 输入模态：text 已有 / audio 进行中 / image·touch·thermal 远期（见 04_DECISIONS #27） */
  modality?: 'text' | 'audio' | 'image' | 'touch' | 'thermal' | 'smell' | string
  /** 引擎：规则 or 模型（用于事后分析"这条是谁判的"） */
  engine?: 'rules' | 'llm' | 'pi'
  /** 落库结果或拦截原因 */
  payload?: TPayload
  createdAt: string
  updatedAt: string
}
