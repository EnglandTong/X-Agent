/**
 * Observation —— 所有感官进 Agent 之前的**统一输入**。
 *
 * 命题（Owner 定，决策 #27）：
 *   无论键盘、麦克风、相机、远期传感器 —— 到核心里都是同一种东西。
 *   Agent / 模型吃的永远是 Observation（或其已辨认后的 text 载荷），
 *   **不**直接吃硬件字节、不直接吃供应商 SDK 返回值。
 *
 * 三层拆分：
 *   采集（换硬件才改）→ 辨认 / 适配器（换 ASR·OCR·模型才改）→ 决策核心（永远不改）
 *
 * ⚠️ 本文件**只有类型**，不得 import server/。加官 = 加 modality 枚举值，不改结构。
 */

/** 开放枚举：加官只加值，不改 Observation 结构 */
export type Modality =
  | 'text' // 键盘 / 输入法 —— 已有
  | 'audio' // 耳：ASR（browser | local）—— 已有
  | 'image' // 眼：OCR / 远期 VLM —— 未接
  | 'touch'
  | 'thermal'
  | 'smell'
  | (string & {})

/**
 * 一次观测。所有感官在协议里产出同一种东西。
 *
 * 现行约定：Agent 决策入口实际消费的是 `text`（辨认后的自然语言）。
 * audio / image 的适配器职责 = 把原始信号辨认成 text，再填进 Observation，
 * 然后走与键盘输入**完全相同**的 interpret 路径。
 */
export interface Observation {
  /** 感官种类 */
  modality: Modality
  /** 来源标识，如 mic-01 / canvas-input / cam-front */
  source: string
  /** ISO8601 */
  at: string
  /**
   * 辨认后的结构化结果。
   * 现阶段核心只认 string（自然语言原话）；远期可扩对象，但**不得**让核心去解析供应商特有字段。
   */
  payload: string | Record<string, unknown>
  /** 辨认器自评 0–1；缺省表示未知 */
  confidence?: number
  /** 原始信号引用（文件路径 / blob id / 不落库的临时句柄），核心不读内容 */
  raw?: string
  /** 辨认器用了哪条实现（browser-webspeech / local-sensevoice / …） */
  recognizer?: string
}

/**
 * 感官 / 模型适配器 —— **外层，可换**。
 *
 * 两类对接人只实现这一侧：
 *   1. 感官适配器：硬件/SDK → Observation（耳、眼、…）
 *   2. 模型适配器：Observation.text → { verb, slots }（云端 / 本地 / 规则）
 *
 * 核心（interpret → resolve → confirm → run）**不**依赖任何适配器实现。
 */
export interface SensoryAdapter {
  /** 适配器自称，写入 Observation.recognizer */
  id: string
  modality: Modality
  /** 原始信号 → Observation；失败抛错或返回 ok:false（由宿主约定） */
  recognize(input: unknown): Promise<Observation> | Observation
}

export interface ModelAdapterResult {
  verb: string
  confidence: number
  /** 槽位名 → 用户原话片段（红线：不输出 ID、不算日期、不转数字） */
  slots: Record<string, string>
  ms?: number
  raw?: string
  error?: string
}

/**
 * 模型适配器：吃**已经是自然语言的** Observation（或直接吃 text），
 * 吐出动词 + 原话槽位。消解不在这里做。
 */
export interface ModelAdapter {
  id: string
  /** 如 openai-compatible / rules / pi */
  kind: 'llm' | 'rules' | 'pi' | string
  extract(observation: Observation | string): Promise<ModelAdapterResult>
}

/** 从 Observation 取出核心要吃的自然语言；非 string payload 时返回空串（强制适配器先辨认） */
export function observationText(o: Observation): string {
  if (typeof o.payload === 'string') return o.payload.trim()
  if (o.payload && typeof (o.payload as { text?: unknown }).text === 'string') {
    return String((o.payload as { text: string }).text).trim()
  }
  return ''
}

/** 键盘输入 → Observation 的便捷构造（零适配器路径） */
export function textObservation(
  text: string,
  opts: { source?: string; at?: string } = {}
): Observation {
  return {
    modality: 'text',
    source: opts.source ?? 'canvas-input',
    at: opts.at ?? new Date().toISOString(),
    payload: text.trim(),
    confidence: 1,
    recognizer: 'passthrough',
  }
}
