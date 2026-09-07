import { Card, Table, Tag, Alert, Space, Empty, Typography } from 'antd'
import type { VerbResult } from '../types'

const ISSUE_META = {
  warn: { alert: 'warning' as const, tag: 'warning' as const, text: '提示' },
  confirm: { alert: 'warning' as const, tag: 'orange' as const, text: '需复核' },
  block: { alert: 'error' as const, tag: 'error' as const, text: '已拦截' },
}

/**
 * 金额安全格式化。
 *
 * 为什么必须有：不是每个动词的 data 都带 amount ——
 * inventory.query / customer.query / delivery.query 返回的是数组，
 * credit.check 返回 { creditLimit, creditUsed, ... }，delivery.* 返回 { deliveryNo, ... }。
 * 早期这里直接 `v.toLocaleString()`，于是「查库存」「查信用」这类格子一落，整个画布白屏。
 * 画布是不可变资产：一个格子渲染失败，不该带走整页历史。
 */
function money(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '—'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
}

const STATUS_COLOR: Record<string, string> = {
  草稿: 'default',
  已确认: 'blue',
  已出货: 'green',
  已取消: 'red',
}

/**
 * bare=true 时不套 Card，由外层格子容器提供外壳。
 * 这样同一个结果既能单独展示，也能嵌进画布的格子里。
 */
export function ResultView({
  verb,
  result,
  bare = false,
}: {
  verb: string
  result: VerbResult
  bare?: boolean
}) {
  const body =
    verb === 'order.query' ? <QueryBody result={result} /> : <CreateBody result={result} />
  if (bare) return body
  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      title={<span style={{ fontSize: 14 }}>{result.message}</span>}
    >
      {body}
    </Card>
  )
}

function Issues({ result }: { result: VerbResult }) {
  if (!result.issues?.length) return null
  return (
    <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 10 }}>
      {result.issues.map((i, idx) => (
        <Alert
          key={idx}
          type={ISSUE_META[i.level].alert}
          showIcon
          message={
            <span style={{ fontSize: 13 }}>
              <Tag color={ISSUE_META[i.level].tag} style={{ fontSize: 11, marginInlineEnd: 6 }}>
                {ISSUE_META[i.level].text}
              </Tag>
              {i.message}
            </span>
          }
        />
      ))}
    </Space>
  )
}

function QueryBody({ result }: { result: VerbResult }) {
  const rows = Array.isArray(result.data) ? (result.data as any[]) : []

  if (!result.ok) {
    return (
      <>
        <Issues result={result} />
        <Typography.Text type="danger">{result.message}</Typography.Text>
      </>
    )
  }
  if (rows.length === 0) {
    return <Empty description={result.message} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <>
      <div style={{ fontSize: 13, marginBottom: 8 }}>{result.message}</div>
      <Issues result={result} />
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        rowKey="no"
        scroll={{ x: 620 }}
        columns={[
          {
            title: '订单号',
            dataIndex: 'no',
            width: 128,
            render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code>,
          },
          { title: '客户', dataIndex: 'customer', width: 88 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 78,
            render: (v: string) => (
              <Tag color={STATUS_COLOR[v] ?? 'default'} style={{ fontSize: 11 }}>
                {v}
              </Tag>
            ),
          },
          { title: '仓库', dataIndex: 'warehouse', width: 78 },
          { title: '交期', dataIndex: 'deliveryDate', width: 98 },
          {
            title: '金额',
            dataIndex: 'amount',
            width: 98,
            align: 'right',
            render: (v: unknown) => (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(v)}</span>
            ),
          },
          {
            title: '明细',
            dataIndex: 'items',
            render: (items: any[]) =>
              items?.map((i) => `${i.model} ×${i.qty} @¥${i.unitPrice}`).join('，') ?? '—',
          },
        ]}
      />
    </>
  )
}

function CreateBody({ result }: { result: VerbResult }) {
  // 数组 / null / 空都不是「订单对象」—— 不要按订单字段去取，取不到就别渲染那一行
  const d =
    result.data && !Array.isArray(result.data) ? (result.data as Record<string, any>) : null
  return (
    <>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {result.ok ? '✅ ' : '⛔ '}
        {result.message}
      </div>
      <Issues result={result} />
      {d && (
        <Space direction="vertical" size={2} style={{ fontSize: 13 }}>
          {d.no && (
            <div>
              订单号 <code>{d.no}</code>
              {d.mode === 'change' && (
                <Tag color="purple" style={{ fontSize: 10, marginInlineStart: 4 }}>
                  变更单
                </Tag>
              )}
              {d.mode === 'revise' && (
                <Tag color="orange" style={{ fontSize: 10, marginInlineStart: 4 }}>
                  原地修订
                </Tag>
              )}
            </div>
          )}
          {(d.customer || d.warehouse || d.deliveryDate) && (
            <div>
              客户 <b>{d.customer ?? '—'}</b> · 仓库 {d.warehouse ?? '—'} · 交期{' '}
              {d.deliveryDate ?? '—'}
            </div>
          )}
          {d.originNo && (
            <div style={{ fontSize: 12, color: '#722ed1' }}>
              变更自 <code>{d.originNo}</code> · 两单各自独立，靠这个单号串联
            </div>
          )}
          {(typeof d.amount === 'number' || d.status) && (
            <div>
              {typeof d.amount === 'number' && (
                <>
                  金额{' '}
                  <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money(d.amount)}</b>{' '}
                </>
              )}
              {d.status ? (
                <>
                  · 状态 <Tag style={{ fontSize: 11 }}>{d.status}</Tag>
                </>
              ) : null}
            </div>
          )}
        </Space>
      )}
    </>
  )
}
