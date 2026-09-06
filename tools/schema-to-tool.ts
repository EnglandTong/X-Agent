#!/usr/bin/env tsx
/**
 * Formily Schema → Tool Schema 编译器
 *
 * 这是「一份 Schema，两个消费者」的核心实现：
 *   消费者 A：Formily 渲染器 → 给人看的表单
 *   消费者 B：本编译器     → 给 LLM 的工具定义
 *
 * 用法：
 *   npx tsx tools/schema-to-tool.ts schema/order.create.json [输出路径]
 *
 * 作者：Owner
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

// ---------------------------------------------------------------- 类型定义

interface AgentExt {
  /** 从自然语言中抽取的槽位名（会成为 tool 参数名） */
  extract?: string
  /** 消解策略：fuzzy_customer | fuzzy_product | number_normalize | date_parse | enum | lookup_price_list | passthrough */
  resolution?: string
  /** 缺失时是否反问 */
  askIfMissing?: boolean
  /** 推断来源，如 customer_last_order */
  inferFrom?: string
  /** 推断置信度默认值 */
  confidenceDefault?: number
  /** few-shot 示例，直接喂给小模型 */
  examples?: string[]
  /** 给开发者的备注，不参与编译 */
  notes?: string
}

interface FormilyField {
  type: string
  title: string
  enum?: string[]
  minimum?: number
  maximum?: number
  default?: unknown
  description?: string
  'x-agent'?: AgentExt
  [key: string]: unknown
}

interface FormilySchema {
  type: 'object'
  title?: string
  properties: Record<string, FormilyField>
  required?: string[]
  'x-verb'?: string
  'x-description'?: string
  'x-risk'?: 'read' | 'write'
  'x-requires-confirm'?: boolean
  'x-precheck'?: unknown[]
  'x-postcheck'?: unknown[]
}

interface ToolParameter {
  type: string
  description: string
  enum?: string[]
  minimum?: number
  maximum?: number
  default?: unknown
  'x-resolution'?: string
  'x-askIfMissing'?: boolean
  'x-inferFrom'?: string
  'x-confidenceDefault'?: number
  'x-examples'?: string[]
}

interface ToolSchema {
  name: string
  description: string
  risk: 'read' | 'write'
  requiresConfirm: boolean
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required: string[]
  }
  precheck?: unknown[]
}

// ---------------------------------------------------------------- 编译器

export function compile(schema: FormilySchema): ToolSchema {
  // --- 校验：元数据完整性 ---
  if (!schema['x-verb']) {
    throw new Error(`[${schema.title}] 缺少 x-verb，无法生成工具名`)
  }

  const properties: Record<string, ToolParameter> = {}
  const slotOf: Record<string, string> = {} // 原字段名 → 槽位名
  const errors: string[] = []

  for (const [fieldName, field] of Object.entries(schema.properties)) {
    const agent = field['x-agent'] ?? {}
    const slot = agent.extract ?? fieldName
    slotOf[fieldName] = slot

    // 校验：必填字段必须声明 extract，否则 LLM 不知道该抽什么
    if (schema.required?.includes(fieldName) && !agent.extract) {
      errors.push(
        `必填字段 "${fieldName}" 未声明 x-agent.extract —— LLM 将无法知道要抽什么槽位`
      )
    }

    // 关键映射：title → description
    // 这就是为什么"工具参数描述是白送的"—— 表单标签直接复用
    const param: ToolParameter = {
      type: field.type,
      description: field.title,
    }

    // 约束透传（人和 AI 共用同一套约束）
    if (field.enum) param.enum = field.enum
    if (field.minimum !== undefined) param.minimum = field.minimum
    if (field.maximum !== undefined) param.maximum = field.maximum
    if (field.default !== undefined) param.default = field.default

    // Agent 专用信息
    if (agent.resolution) param['x-resolution'] = agent.resolution
    if (agent.askIfMissing !== undefined) param['x-askIfMissing'] = agent.askIfMissing
    if (agent.inferFrom) param['x-inferFrom'] = agent.inferFrom
    if (agent.confidenceDefault !== undefined) {
      param['x-confidenceDefault'] = agent.confidenceDefault
    }
    if (agent.examples?.length) param['x-examples'] = agent.examples

    properties[slot] = param
  }

  if (errors.length) {
    throw new Error(`Schema 校验失败：\n  - ${errors.join('\n  - ')}`)
  }

  // required 需要把原字段名映射成槽位名
  const required = (schema.required ?? []).map((f) => slotOf[f] ?? f)

  // 校验：required 引用的字段必须存在
  for (const r of required) {
    if (!properties[r]) {
      throw new Error(`required 引用了不存在的参数 "${r}"`)
    }
  }

  return {
    name: schema['x-verb'],
    description: schema['x-description'] ?? schema.title ?? schema['x-verb'],
    risk: schema['x-risk'] ?? 'read',
    requiresConfirm: schema['x-requires-confirm'] ?? schema['x-risk'] === 'write',
    parameters: {
      type: 'object',
      properties,
      required,
    },
    ...(schema['x-precheck'] ? { precheck: schema['x-precheck'] } : {}),
  }
}

// ---------------------------------------------------------------- CLI 入口

function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('用法: npx tsx tools/schema-to-tool.ts <schema.json> [输出路径]')
    process.exit(1)
  }

  const raw = JSON.parse(readFileSync(input, 'utf-8')) as FormilySchema
  const tool = compile(raw)

  const output =
    process.argv[3] ??
    input.replace(/\.json$/, '.tool.json')

  writeFileSync(output, JSON.stringify(tool, null, 2) + '\n', 'utf-8')

  const slots = Object.keys(tool.parameters.properties)
  console.log(`✅ ${basename(input)} → ${basename(output)}`)
  console.log(`   工具名: ${tool.name}`)
  console.log(`   风险级: ${tool.risk}  (需确认: ${tool.requiresConfirm})`)
  console.log(`   参数数: ${slots.length}  必填: ${tool.parameters.required.length}`)
  console.log(`   槽位: ${slots.join(', ')}`)
}

main()
