/**
 * 动词层（Verb Layer）—— 一等公民
 *
 * 在 AGT-ERP 里，「能做什么」不是由一个一个 REST endpoint 表达的，
 * 而是由一组有限的、自描述的「动词」表达：
 *
 *   order.query        查订单
 *   order.create       建订单
 *   credit.check       查信用
 *   inventory.availability  查库存可用性
 *   shipment.createFromOrder 从订单生成出货单
 *   ...
 *
 * 为什么是动词而不是 REST：
 *   1. 数量可控 —— 12 个动词 vs 100 个 endpoint，模型不会迷路
 *   2. 语义稳定 —— 动词名就是意图，不需要模型拼 URL / 猜参数组合
 *   3. 自描述 —— `erp schema order.create` 能打印出完整参数说明（CLI 可自省原则）
 *   4. 双向复用 —— 同一份动词定义，UI 拿去渲染表单，模型拿去当工具
 */

import type { PrismaClient } from '@prisma/client'

export interface VerbCtx {
  db: PrismaClient
  actor: string
}

export interface VerbIssue {
  level: 'warn' | 'block' | 'confirm'
  rule: string
  message: string
}

export interface VerbResult {
  ok: boolean
  /** 结构化结果，UI 直接渲染 */
  data?: unknown
  /** 给用户看的一句人话 */
  message: string
  issues?: VerbIssue[]
}

export interface Verb {
  name: string
  risk: 'read' | 'write'
  run: (args: Record<string, unknown>, ctx: VerbCtx) => Promise<VerbResult>
}
