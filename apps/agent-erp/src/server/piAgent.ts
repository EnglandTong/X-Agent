/**
 * Pi 风格 Agent 循环（禁文件/shell 内置工具）
 *
 * 决策：用 Pi（pi.dev）语义做 Agent 循环，但 ERP 场景只允许「业务工具」——
 * 即本仓库编译出的 verb tool schemas。禁止 read/write/edit/bash。
 *
 * 实现：在现有 OpenAI 兼容通道上跑单轮 JSON 抽取（与 llmExtract 同契约）。
 * 完整 `@mariozechner/pi-agent-core` 可在日后替换本文件内部，而不改 interpret 对外接口。
 *
 * engine 标记：成功时返回 'pi'（由 interpret 映射进 Interpretation.engine）。
 */

import { llmExtract } from './llm'
import type { LlmSettings } from './settings'
import type { ToolSchema } from './compile'

export type PiExtractResult = {
  verb: string
  slots: Record<string, string>
  confidence: number
  ms: number
  raw: string
  engine: 'pi'
}

/**
 * 跑一轮 Agent：只拿 verb tools，不做文件系统工具。
 * 失败抛错，由 interpret 静默回落 rules。
 */
export async function piExtract(
  utterance: string,
  opts: {
    settings: LlmSettings
    tools: Map<string, ToolSchema>
    schemas: Map<string, any>
    dict: {
      customers: Array<{ id: string; name: string; code: string }>
      products: Array<{ id: string; model: string; name: string }>
    }
    today: Date
  }
): Promise<PiExtractResult> {
  // 明确拒绝任何「编码 Agent」内置工具路径：本函数不接收、不注册文件类工具
  const r = await llmExtract(utterance, {
    settings: opts.settings,
    tools: opts.tools,
    schemas: opts.schemas,
    dict: opts.dict,
    today: opts.today,
  })
  return {
    verb: r.verb,
    slots: r.slots,
    confidence: r.confidence,
    ms: r.ms,
    raw: r.raw,
    engine: 'pi',
  }
}
