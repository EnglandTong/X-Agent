import type { Verb, VerbIssue } from './types'
import { STATUS_LABEL } from '../resolve'

type LineIn = { productId: string; qty: number; unitPrice?: number | null }

function normalizeLines(args: Record<string, unknown>): LineIn[] {
  if (Array.isArray(args.items) && args.items.length > 0) {
    return (args.items as any[]).map((it) => ({
      productId: String(it.productId),
      qty: Number(it.qty),
      unitPrice:
        it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== ''
          ? Number(it.unitPrice)
          : null,
    }))
  }
  if (args.productId != null && args.productId !== '' && args.qty != null && args.qty !== '') {
    return [
      {
        productId: String(args.productId),
        qty: Number(args.qty),
        unitPrice:
          args.unitPrice !== undefined && args.unitPrice !== null && args.unitPrice !== ''
            ? Number(args.unitPrice)
            : null,
      },
    ]
  }
  return []
}

/** 同产品合并为一行（剩余量按 productId 记账） */
function mergeLines(lines: LineIn[]): LineIn[] {
  const map = new Map<string, LineIn>()
  for (const l of lines) {
    const prev = map.get(l.productId)
    if (!prev) {
      map.set(l.productId, { ...l })
      continue
    }
    prev.qty += l.qty
    if (prev.unitPrice == null && l.unitPrice != null) prev.unitPrice = l.unitPrice
  }
  return [...map.values()]
}

/**
 * order.create —— 写入动词。
 *
 * 三道闸：precheck（提示）→ 领域校验（拦截）→ postcheck（业务规则）。
 * 支持单行（productId+qty）或多行（items[]）；多行优先。
 */
export const orderCreate: Verb = {
  name: 'order.create',
  risk: 'write',

  async run(args, ctx) {
    const { db, actor } = ctx
    const issues: VerbIssue[] = []

    const customerId = args.customerId as string
    const warehouse = (args.warehouseId as string | undefined) ?? null
    const currency = (args.currency as string | undefined) ?? 'CNY'
    const remark = (args.remark as string | undefined) ?? null
    const deliveryDate = (args.deliveryDate as string | undefined) ?? null
    /** 变更单模式：非空 = 另开新单，用业务关键字段（原单号）串联两单 */
    const originNoInput = (args.originNo as string | undefined) ?? null
    /** 原地修订模式：非空 = 改同一张单，仅草稿可用 */
    const reviseOrderId = (args.orderId as string | undefined) ?? null

    const rawLines = normalizeLines(args)
    if (!rawLines.length) {
      return {
        ok: false,
        message: '请提供订单行：items[] 或 productId + qty。',
        issues: [],
      }
    }
    for (const l of rawLines) {
      if (!Number.isFinite(l.qty) || l.qty < 1) {
        return { ok: false, message: '订单行数量必须 ≥ 1。', issues: [] }
      }
    }
    const lines = mergeLines(rawLines)

    // ------------------------------------------------ 修订前置检查
    let revising: Awaited<ReturnType<typeof db.order.findUnique>> = null
    if (reviseOrderId && !originNoInput) {
      revising = await db.order.findUnique({ where: { id: reviseOrderId } })
      if (!revising) {
        return { ok: false, message: '要修改的订单不存在。', issues: [] }
      }
      if (revising.status !== 'DRAFT') {
        return {
          ok: false,
          message: `订单 ${revising.no} 已${revising.status === 'CONFIRMED' ? '确认' : revising.status === 'SHIPPED' ? '出货' : '取消'}，不可直接修改，请走变更流程。`,
          issues: [],
        }
      }
    }

    const customer = await db.customer.findUnique({ where: { id: customerId } })
    if (!customer) return { ok: false, message: '客户不存在（可能已被删除）。', issues: [] }

    const products = await db.product.findMany({
      where: { id: { in: lines.map((l) => l.productId) } },
    })
    const productById = new Map(products.map((p) => [p.id, p]))
    for (const l of lines) {
      if (!productById.has(l.productId)) {
        return { ok: false, message: `产品不存在（${l.productId}）。`, issues: [] }
      }
    }

    const resolvedLines = lines.map((l) => {
      const product = productById.get(l.productId)!
      const unitPrice =
        l.unitPrice != null && Number.isFinite(l.unitPrice) ? l.unitPrice : product.price
      const amount = Math.round(l.qty * unitPrice * 100) / 100
      return { productId: l.productId, qty: l.qty, unitPrice, amount, product }
    })
    const totalAmount =
      Math.round(resolvedLines.reduce((s, l) => s + l.amount, 0) * 100) / 100

    // 变更时：原单若已占用额度，建草稿检查可把原单金额加回可用（落库时释放）
    const OCCUPYING = new Set(['CONFIRMED', 'PARTIALLY_SHIPPED', 'SHIPPED'])
    let originForChange: Awaited<ReturnType<typeof db.order.findFirst>> = null
    let creditRelief = 0
    if (originNoInput) {
      originForChange = await db.order.findFirst({ where: { no: originNoInput } })
      if (originForChange && OCCUPYING.has(originForChange.status)) {
        creditRelief = originForChange.totalAmount
      }
    }

    // ------------------------------------------------ postcheck: 业务规则
    const remain = customer.creditLimit - customer.creditUsed + creditRelief
    if (totalAmount > remain) {
      issues.push({
        level: 'block',
        rule: 'credit_limit',
        message: `订单金额 ¥${totalAmount.toLocaleString('zh-CN')} 超出可用额度 ¥${remain.toLocaleString('zh-CN')}（总额度 ¥${customer.creditLimit.toLocaleString('zh-CN')}，已用 ¥${customer.creditUsed.toLocaleString('zh-CN')}）`,
      })
    }

    const MIN_AMOUNT = 500
    if (totalAmount < MIN_AMOUNT) {
      issues.push({
        level: 'block',
        rule: 'min_order_amount',
        message: `订单金额 ¥${totalAmount.toLocaleString('zh-CN')} 低于起订金额 ¥${MIN_AMOUNT}`,
      })
    }

    for (const l of resolvedLines) {
      const ratio = l.unitPrice / l.product.price
      if (ratio < 0.85) {
        issues.push({
          level: 'confirm',
          rule: 'price_floor',
          message: `「${l.product.model}」单价 ¥${l.unitPrice} 低于牌价 ¥${l.product.price} 的 85%（${(ratio * 100).toFixed(1)}%），需人工复核`,
        })
      }
    }

    if (warehouse) {
      for (const l of resolvedLines) {
        const inv = await db.inventory.findFirst({
          where: { productId: l.productId, warehouse },
        })
        const avail = inv?.qty ?? 0
        if (avail < l.qty) {
          issues.push({
            level: 'warn',
            rule: 'inventory_shortage',
            message: `${warehouse}「${l.product.model}」现有 ${avail} ${l.product.unit}，本次需 ${l.qty} ${l.product.unit}，缺 ${l.qty - avail} ${l.product.unit}`,
          })
        }
      }
    }

    const blocking = issues.filter((i) => i.level === 'block')
    if (blocking.length) {
      return {
        ok: false,
        message: `订单未创建：${blocking.map((i) => i.message).join('；')}`,
        issues,
      }
    }

    // ------------------------------------------------ 落库
    let order: Awaited<ReturnType<typeof db.order.create>> & {
      customer: { name: string }
      items: Array<{ productId: string; qty: number; unitPrice: number; amount: number }>
    }
    let mode: 'create' | 'revise' | 'change' = 'create'
    let originNo: string | null = null
    let chainId: string | null = null

    if (originNoInput) {
      const origin = originForChange ?? (await db.order.findFirst({ where: { no: originNoInput } }))
      if (!origin) {
        return { ok: false, message: `原单 ${originNoInput} 不存在。`, issues: [] }
      }
      if (origin.status === 'SUPERSEDED') {
        return {
          ok: false,
          message: `原单 ${origin.no} 已被 ${origin.supersededByNo} 变更过，不能再次变更（应对最新的那张单操作）。`,
          issues: [],
        }
      }
      if (origin.status === 'CANCELLED') {
        return { ok: false, message: `原单 ${origin.no} 已取消，不能变更。`, issues: [] }
      }

      mode = 'change'
      originNo = origin.no
      originForChange = origin
      chainId = origin.chainId ?? origin.no
    } else if (revising) {
      mode = 'revise'
    }

    const itemCreates = resolvedLines.map((l) => ({
      productId: l.productId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: l.amount,
    }))

    if (mode === 'revise' && revising) {
      order = await db.order.update({
        where: { id: revising.id },
        data: {
          customerId,
          warehouse,
          deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
          currency,
          totalAmount,
          remark,
          items: {
            deleteMany: {},
            create: itemCreates,
          },
        },
        include: { customer: true, items: { include: { product: true } } },
      })
    } else {
      const year = new Date().getFullYear()
      const last = await db.order.findFirst({
        where: { no: { startsWith: `SO-${year}-` } },
        orderBy: { no: 'desc' },
      })
      const seq = last ? Number(last.no.split('-')[2]) + 1 : 1001

      order = await db.order.create({
        data: {
          no: `SO-${year}-${seq}`,
          customerId,
          warehouse,
          status: 'DRAFT',
          deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
          currency,
          totalAmount,
          remark,
          createdBy: actor,
          originNo,
          chainId,
          items: {
            create: itemCreates,
          },
        },
        include: { customer: true, items: { include: { product: true } } },
      })

      if (mode === 'change' && originNo && originForChange) {
        await db.$transaction(async (tx: any) => {
          await tx.order.update({
            where: { no: originNo },
            data: { status: 'SUPERSEDED', supersededByNo: order.no },
          })
          if (OCCUPYING.has(originForChange!.status) && originForChange!.totalAmount > 0) {
            const cust = await tx.customer.findUnique({
              where: { id: originForChange!.customerId },
            })
            if (cust) {
              await tx.customer.update({
                where: { id: originForChange!.customerId },
                data: {
                  creditUsed: Math.max(0, cust.creditUsed - originForChange!.totalAmount),
                },
              })
            }
          }
        })
      }
    }

    const money = `¥${totalAmount.toLocaleString('zh-CN')}`
    const lineSummary = resolvedLines
      .map((l) => `${l.product.model}×${l.qty}`)
      .join('、')
    return {
      ok: true,
      data: {
        id: order.id,
        no: order.no,
        customer: order.customer.name,
        amount: order.totalAmount,
        status: STATUS_LABEL[order.status] ?? order.status,
        statusRaw: order.status,
        warehouse: order.warehouse ?? '—',
        deliveryDate: order.deliveryDate
          ? order.deliveryDate.toISOString().slice(0, 10)
          : '—',
        mode,
        originNo,
        chainId,
        lineCount: resolvedLines.length,
        lines: resolvedLines.map((l) => ({
          product: l.product.model,
          qty: l.qty,
          unitPrice: l.unitPrice,
          amount: l.amount,
        })),
      },
      message:
        mode === 'change'
          ? `变更单 ${order.no} 已创建（${money}，${lineSummary}），原单 ${originNo} 已冻结为「已变更」并指向本单。`
          : mode === 'revise'
            ? `订单 ${order.no} 已修改为 ${money}（${lineSummary}；原 ¥${revising!.totalAmount.toLocaleString('zh-CN')}）。`
            : `订单 ${order.no} 已创建（草稿），金额 ${money}，${resolvedLines.length} 行：${lineSummary}。`,
      issues: issues.length ? issues : undefined,
    }
  },
}
