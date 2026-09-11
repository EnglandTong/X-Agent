/**
 * 前后端共享类型。
 * 单独放一个文件，避免前端 import 后端模块时把 Prisma 拖进浏览器包。
 */

export interface SlotResult {
  slot: string
  field: string
  title: string
  raw: unknown
  value: unknown
  label?: string
  confidence: number
  source: 'user' | 'inferred' | 'missing'
  required: boolean
  candidates?: Array<{ id: string; label: string; hint?: string }>
  note?: string
}

export interface ContextSummaryLine {
  kind: 'credit' | 'inventory'
  text: string
  source: string
}

export interface ContextSummary {
  lines: ContextSummaryLine[]
}

export interface Interpretation {
  utterance: string
  verb: string
  verbTitle: string
  verbConfidence: number
  risk: 'read' | 'write'
  requiresConfirm: boolean
  slots: SlotResult[]
  missing: string[]
  question?: string
  ready: boolean
  /** 抽取引擎：rules = 规则，llm = 模型 */
  engine?: 'rules' | 'llm'
  llm?: { ms: number; error?: string; raw?: string }
  contextSummary?: ContextSummary
  contextApplied?: { kind: string; customer?: string }
}

export interface VerbIssue {
  level: 'warn' | 'block' | 'confirm'
  rule: string
  message: string
}

export interface VerbResult {
  ok: boolean
  data?: unknown
  message: string
  issues?: VerbIssue[]
}

/** 画布格子 —— 提交即冻结，永不原地修改 */
export interface Panel {
  id: string
  seq: number
  verb: string
  title: string
  status: 'SUBMITTED' | 'SUPERSEDED'
  utterance: string | null
  slots: SlotResult[] | null
  result: VerbResult | null
  ok: boolean
  correlationId: string | null
  entities: Array<{ type: string; value: string; label: string }> | null
  supersedesId: string | null
  /** 关联订单的**实时**状态 —— 格子快照可能已过期，UI 按钮要按它来分流 */
  liveStatus?: string | null
  createdAt: string
}
