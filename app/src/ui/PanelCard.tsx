import { useState } from 'react'
import { Card, Tag, Button, Space, Tooltip } from 'antd'
import { ResultView } from './ResultView'
import type { Panel } from '../types'

interface Props {
  panel: Panel
  /** 取代了它的那一格编号（若有） */
  supersededBy?: number
  /** 它修订自哪一格编号（若有） */
  revisesSeq?: number
  onRevise: (panel: Panel) => void
  onConfirm: (panel: Panel) => void
  busy: boolean
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

/**
 * 已提交的格子 —— 只读快照。
 *
 * 不可变模型的具体体现：这里没有任何「编辑」入口，只有「修订」。
 * 修订不是改这一格，而是新开一格，这一格原地冻结成历史。
 */
export function PanelCard({ panel, supersededBy, revisesSeq, onRevise, onConfirm, busy }: Props) {
  const [folded, setFolded] = useState(Boolean(supersededBy))
  const dead = panel.status === 'SUPERSEDED'

  // 按订单的**实时**状态分流（不是格子快照 —— 快照可能已过期）
  //   草稿     → 可「确认」、可原地「修订」
  //   已确认等 → 只能另开「变更单」
  const live = panel.liveStatus ?? (panel.result?.data as any)?.statusRaw ?? null
  const canAct = panel.verb === 'order.create' && panel.ok && !dead
  const isDraft = live === 'DRAFT'
  const actLabel = isDraft ? '修订' : '变更'

  return (
    <Card
      size="small"
      style={{
        marginBottom: 8,
        opacity: dead ? 0.55 : 1,
        borderLeft: `3px solid ${dead ? '#d9d9d9' : panel.ok ? '#52c41a' : '#ff4d4f'}`,
      }}
      styles={{ body: { padding: dead ? 8 : 10 } }}
      title={
        <div
          onClick={() => setFolded((f) => !f)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        >
          <span
            style={{
              background: dead ? '#f5f5f5' : '#e6f4ff',
              color: dead ? '#8c8c8c' : '#0958d9',
              borderRadius: 8,
              padding: '0 6px',
              fontSize: 11,
              fontFamily: 'monospace',
            }}
          >
            #{panel.seq}
          </span>
          <code style={{ fontSize: 11, color: '#595959' }}>{panel.verb}</code>
          <span style={{ fontSize: 11, color: '#bfbfbf' }}>{time(panel.createdAt)}</span>
          {dead && (
            <Tag color="default" style={{ fontSize: 10, margin: 0 }}>
              已被 #{supersededBy} 取代
            </Tag>
          )}
          {revisesSeq && (
            <Tag color="purple" style={{ fontSize: 10, margin: 0 }}>
              修订自 #{revisesSeq}
            </Tag>
          )}
          <span style={{ color: '#bfbfbf', fontSize: 11 }}>{folded ? '▸' : '▾'}</span>
        </div>
      }
      extra={
        canAct ? (
          <Space size={0}>
            {isDraft && (
              <Button size="small" type="link" disabled={busy} onClick={() => onConfirm(panel)}>
                确认
              </Button>
            )}
            <Button size="small" type="link" disabled={busy} onClick={() => onRevise(panel)}>
              {actLabel}
            </Button>
          </Space>
        ) : null
      }
    >
      {folded ? (
        <div style={{ fontSize: 12, color: '#8c8c8c' }}>
          {panel.result?.message ?? '—'}
          {panel.utterance && <span style={{ color: '#bfbfbf' }}> · 「{panel.utterance}」</span>}
        </div>
      ) : (
        <>
          {panel.utterance && (
            <div
              style={{
                fontSize: 12,
                color: '#8c8c8c',
                background: '#fafafa',
                borderRadius: 4,
                padding: '3px 8px',
                marginBottom: 8,
              }}
            >
              「{panel.utterance}」
            </div>
          )}
          {panel.entities && panel.entities.length > 0 && (
            <Space size={4} wrap style={{ marginBottom: 8 }}>
              {panel.entities.map((e, i) => (
                <Tooltip key={i} title={`关联关键词 · ${e.type}`}>
                  <Tag color="geekblue" style={{ fontSize: 10, margin: 0 }}>
                    {e.label}
                  </Tag>
                </Tooltip>
              ))}
            </Space>
          )}
          {panel.result && <ResultView verb={panel.verb} result={panel.result} bare />}
        </>
      )}
    </Card>
  )
}
