import type { Verb, VerbIssue } from './types'
import { STATUS_LABEL } from '../resolve'

/**
 * order.create —— 写入动词。
 *
 * 三道闸：precheck（提示）→ 领域校验（拦截）→ postcheck（业务规则）。
 * 注意分工：
 *   - 结构合法性（必填、类型、范围）由 Schema 层负责，早在调用动词前就完成了
 *   - 业务规则（信用、起订额、价格底线）由本层负责，是代码的确定性判断
 *   - 模型不参与任何一道闸 —— 它只负责把用户的话变成参数
 */
export const orderCreate: Verb = {
  name: 'order.create',
  risk: 'write',

  async run(args, ctx) {
    const { db, actor } = ctx
    const issues: VerbIssue[] = []

    const customerId = args.customerId as string
    const productId = args.productId as string
    const qty = Number(args.qty)
    const unitPrice = Number(args.unitPrice)
    const warehouse = (args.warehouseId as string | undefined) ?? null
    const currency = (args.currency as string | undefined) ?? 'CNY'
    const remark = (args.remark as string | undefined) ?? null
    const deliveryDate = (args.deliveryDate as string | undefined) ?? null
    /** 变更单模式：非空 = 另开新单，用业务关键字段（原单号）串联两单 */
    const originNoInput = (args.originNo as string | undefined) ?? null
    /** 原地修订模式：非空 = 改同一张单，仅草稿可用 */
    const reviseOrderId = (args.orderId as string | undefined) ?? null

    // ------------------------------------------------ 修订前置检查
    // 不可变模型要求：格子提交即冻结，改单 = 新格子替换旧格子。
    // 但领域层仍要守住一条底线 —— 只有草稿能改，已确认/已出货必须走变更流程。
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
    const product = await db.product.findUnique({ where: { id: productId } })

    if (!customer) return { ok: false, message: '客户不存在（可能已被删除）。', issues: [] }
    if (!product) return { ok: false, message: '产品不存在（可能已被删除）。', issues: [] }

    const totalAmount = Math.round(qty * unitPrice * 100) / 100

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
    // 1) 信用额度：block（DRAFT 不占用；此处只预检「确认后是否够」）
    const remain = customer.creditLimit - customer.creditUsed + creditRelief
    if (totalAmount > remain) {
      issues.push({
        level: 'block',
        rule: 'credit_limit',
        message: `订单金额 ¥${totalAmount.toLocaleString('zh-CN')} 超出可用额度 ¥${remain.toLocaleString('zh-CN')}（总额度 ¥${customer.creditLimit.toLocaleString('zh-CN')}，已用 ¥${customer.creditUsed.toLocaleString('zh-CN')}）`,
      })
    }

    // 2) 起订金额：block
    const MIN_AMOUNT = 500
    if (totalAmount < MIN_AMOUNT) {
      issues.push({
        level: 'block',
        rule: 'min_order_amount',
        message: `订单金额 ¥${totalAmount.toLocaleString('zh-CN')} 低于起订金额 ¥${MIN_AMOUNT}`,
      })
    }

    // 3) 价格底线：confirm（低于牌价 85% 需二次确认，不直接拦截）
    const ratio = unitPrice / product.price
    if (ratio < 0.85) {
      issues.push({
        level: 'confirm',
        rule: 'price_floor',
        message: `单价 ¥${unitPrice} 低于牌价 ¥${product.price} 的 85%（${(ratio * 100).toFixed(1)}%），需人工复核`,
      })
    }

    // 4) 库存提示：warn（不阻断，但人要知道）
    if (warehouse) {
      const inv = await db.inventory.findFirst({
        where: { productId, warehouse },
      })
      const avail = inv?.qty ?? 0
      if (avail < qty) {
        issues.push({
          level: 'warn',
          rule: 'inventory_shortage',
          message: `${warehouse} 现有 ${avail} ${product.unit}，本次需 ${qty} ${product.unit}，缺 ${qty - avail} ${product.unit}`,
        })
      }
    }

    // 有 block 级问题 → 直接拒绝，不落库
    const blocking = issues.filter((i) => i.level === 'block')
    if (blocking.length) {
      return {
        ok: false,
        message: `订单未创建：${blocking.map((i) => i.message).join('；')}`,
        issues,
      }
    }

    // ------------------------------------------------ 落库
    // 三种模式，互斥：
    //   A 变更单（originNo）  → 另开新单，原单冻结为 SUPERSEDED，两单靠业务关键字段互指
    //   B 原地修订（orderId） → 仅草稿可用，单号不变
    //   C 新建               → 普通新单
    let order: Awaited<ReturnType<typeof db.order.create>> & {
      customer: { name: string }
    }
    let mode: 'create' | 'revise' | 'change' = 'create'
    let originNo: string | null = null
    let chainId: string | null = null

    if (originNoInput) {
      // ---------- 模式 A：变更单 ----------
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
      // 变更链：继承原单的链根，没有则以原单号为根 —— 这让整条变更链共享一个 chainId
      chainId = origin.chainId ?? origin.no
    } else if (revising) {
      mode = 'revise'
    }

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
            create: [{ productId, qty, unitPrice, amount: totalAmount }],
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
            create: [{ productId, qty, unitPrice, amount: totalAmount }],
          },
        },
        include: { customer: true, items: { include: { product: true } } },
      })

      // 原单反向指回新单并冻结；若原单曾占用额度则释放（新单为 DRAFT，确认时再占用）
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
      },
      message:
        mode === 'change'
          ? `变更单 ${order.no} 已创建（${money}），原单 ${originNo} 已冻结为「已变更」并指向本单。`
          : mode === 'revise'
            ? `订单 ${order.no} 已修改为 ${money}（原 ¥${revising!.totalAmount.toLocaleString('zh-CN')}）。`
            : `订单 ${order.no} 已创建（草稿），金额 ${money}。`,
      issues: issues.length ? issues : undefined,
    }
  },
}
