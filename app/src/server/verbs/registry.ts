import type { Verb } from './types'
import { orderQuery } from './order.query'
import { orderCreate } from './order.create'
import { orderConfirm } from './order.confirm'
import { orderCancel } from './order.cancel'
import { deliveryCreate } from './delivery.create'
import { deliveryConfirm } from './delivery.confirm'
import { deliveryQuery } from './delivery.query'
import { inventoryQuery } from './inventory.query'
import { inventoryReserve } from './inventory.reserve'
import { inventoryRelease } from './inventory.release'
import { customerQuery } from './customer.query'
import { creditCheck } from './credit.check'
import { lexiconRemember } from './lexicon.remember'

/**
 * 动词注册表 —— 全局唯一的「这台系统能做什么」清单。
 * 13 个：订单→出货一条线 12 个 + lexicon.remember（D10 拍板：自然语言「记住」）。
 * 再加动词需 Owner 确认（范围纪律）。
 */
const verbs = new Map<string, Verb>()

for (const v of [
  orderQuery,
  orderCreate,
  orderConfirm,
  orderCancel,
  deliveryCreate,
  deliveryConfirm,
  deliveryQuery,
  inventoryQuery,
  inventoryReserve,
  inventoryRelease,
  customerQuery,
  creditCheck,
  lexiconRemember,
]) {
  verbs.set(v.name, v)
}

export function getVerb(name: string): Verb | undefined {
  return verbs.get(name)
}

export function listVerbs(): Verb[] {
  return [...verbs.values()]
}
