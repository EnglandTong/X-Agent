import type { Verb } from './types'
import { orderQuery } from './order.query'
import { orderCreate } from './order.create'
import { orderConfirm } from './order.confirm'

/**
 * 动词注册表 —— 全局唯一的「这台系统能做什么」清单。
 *
 * 目前 3 个。SPEC 规划满打满算 12 个（订单→出货一条线）。
 * 超过 12 个说明范围在蔓延，回看 SPEC 的 STOP_RULES。
 */
const verbs = new Map<string, Verb>()

for (const v of [orderQuery, orderCreate, orderConfirm]) {
  verbs.set(v.name, v)
}

export function getVerb(name: string): Verb | undefined {
  return verbs.get(name)
}

export function listVerbs(): Verb[] {
  return [...verbs.values()]
}
