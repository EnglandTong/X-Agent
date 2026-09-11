/**
 * lexicon.remember —— 自然语言「记住：A 就是 B」（决策 D10，第 13 个动词）
 *
 * 为什么要有它（T1 实测的教训）：没有这个动词时，「记住：老李就是李四」会被判成
 * customer.query（云端）/ credit.check（断网）—— 语义错且**不报错**，比"做不到"更危险。
 *
 * 范围：一代只支持客户 / 产品两种槽位映射（与记忆网络 v1 一致）。
 * verb 类映射（「开张单 = 开单」）仍走确认卡上的「记住为开单说法」。
 *
 * 消解在代码里做（红线 3：模型只输出原话片段）：
 *   target_text 先按客户名/编码精确 → 包含；再按产品型号/名；都不唯一则弹候选，绝不猜。
 */
import type { PrismaClient } from '@prisma/client'
import type { Verb } from './types'
import { isStandardTerm, observeUsage } from '../lexicon'

interface TargetHit {
  slot: 'customer' | 'product'
  id: string
  label: string
}

function normEq(a: string, b: string): boolean {
  return (
    a.replace(/\s/g, '').toLowerCase() === b.replace(/\s/g, '').toLowerCase()
  )
}

async function resolveTarget(
  db: PrismaClient,
  text: string
): Promise<{ hit?: TargetHit; candidates?: Array<{ id: string; label: string; hint?: string }> }> {
  const t = text.trim()
  if (!t) return {}

  // 1) 客户：name / code 精确 → 包含
  const customers = await db.customer.findMany()
  const cExact = customers.filter((c) => normEq(c.name, t) || normEq(c.code, t))
  if (cExact.length === 1) {
    return { hit: { slot: 'customer', id: cExact[0].id, label: `${cExact[0].name}（${cExact[0].code}）` } }
  }
  const cLoose = customers.filter((c) => c.name.includes(t) || t.includes(c.name))
  if (cExact.length > 1 || cLoose.length > 1) {
    const list = (cExact.length ? cExact : cLoose).map((c) => ({
      id: c.id,
      label: `${c.name}（${c.code}）`,
      hint: `${c.level} 级客户`,
    }))
    return { candidates: list }
  }
  if (cLoose.length === 1) {
    return { hit: { slot: 'customer', id: cLoose[0].id, label: `${cLoose[0].name}（${cLoose[0].code}）` } }
  }

  // 2) 产品：model / name 精确 → 包含
  const products = await db.product.findMany()
  const pExact = products.filter((p) => normEq(p.model, t) || normEq(p.name, t))
  if (pExact.length === 1) {
    return { hit: { slot: 'product', id: pExact[0].id, label: `${pExact[0].model} ${pExact[0].name}` } }
  }
  const pLoose = products.filter((p) => p.name.includes(t) || t.includes(p.model) || t.includes(p.name))
  if (pExact.length > 1 || pLoose.length > 1) {
    const list = (pExact.length ? pExact : pLoose).map((p) => ({
      id: p.id,
      label: `${p.model} ${p.name}`,
      hint: `牌价 ¥${p.price}`,
    }))
    return { candidates: list }
  }
  if (pLoose.length === 1) {
    return { hit: { slot: 'product', id: pLoose[0].id, label: `${pLoose[0].model} ${pLoose[0].name}` } }
  }

  return {}
}

export const lexiconRemember: Verb = {
  name: 'lexicon.remember',
  risk: 'write',

  async run(args, ctx) {
    const phrase = String(args.phrase ?? '').trim()
    const targetText = String(args.target_text ?? '').trim()

    if (!phrase || phrase.length < 2) {
      return { ok: false, message: '要记的说法至少 2 个字（防单字误绑）。' }
    }
    if (!targetText) {
      return { ok: false, message: '缺少「指的是什么」。' }
    }

    // 标准名不需要记（本来就认得）
    const targetProbe = await resolveTarget(ctx.db, targetText)
    if (targetProbe.hit && (await isStandardTerm(ctx.db, phrase, targetProbe.hit.slot))) {
      return {
        ok: false,
        message: `「${phrase}」是${targetProbe.hit.slot === 'customer' ? '客户' : '产品'}标准名，系统本来就认得，不用记。`,
      }
    }

    const { hit, candidates } = targetProbe

    if (!hit) {
      return {
        ok: false,
        message: candidates?.length
          ? `「${targetText}」匹配到多个目标，请选择一个。`
          : `没有找到叫「${targetText}」的客户或产品 —— 记忆必须指向真实主数据，不能记空。`,
        ...(candidates?.length ? { data: { candidates } } : {}),
      }
    }

    // explicit：点「记住」语义，立即生效（不受跨天阈值限制）
    const r = await observeUsage(ctx.db, {
      phrase,
      slot: hit.slot,
      targetId: hit.id,
      targetLabel: hit.label,
      source: 'explicit',
    })

    return {
      ok: true,
      message: `已记住：「${phrase}」= ${hit.label}（${hit.slot === 'customer' ? '客户' : '产品'}），下次直接说「${phrase}」就认。`,
      data: {
        phrase,
        slot: hit.slot,
        targetId: hit.id,
        targetLabel: hit.label,
        status: r.status,
      },
    }
  },
}
