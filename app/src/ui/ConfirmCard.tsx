import { useMemo } from 'react'
import { createForm } from '@formily/core'
import { FormProvider, FormConsumer } from '@formily/react'
import { FormLayout } from '@formily/antd-v5'
import { Card, Tag, Button, Space, Divider, Tooltip } from 'antd'
import { SchemaField } from './formily'
import type { SlotResult } from '../types'

interface Props {
  schema: any
  slots: SlotResult[]
  title: string
  verb: string
  risk: 'read' | 'write'
  question?: string
  /** 非空表示这是从 #N 修订而来的新格 */
  revisesSeq?: number
  submitting: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void
}

const SOURCE_META = {
  user: { color: 'green', text: '你说的' },
  inferred: { color: 'orange', text: '系统推断' },
  missing: { color: 'red', text: '待补' },
} as const

/** 非必填字段留空不是问题，标灰即可 —— 别把「可选项没填」渲染成错误 */
function sourceMeta(slot: SlotResult) {
  if (slot.source === 'missing' && !slot.required) {
    return { color: 'default' as const, text: '留空' }
  }
  return SOURCE_META[slot.source]
}

/**
 * 把「消解结果」注入 Schema，生成可直接渲染的表单 Schema。
 *
 * 这里做了一件很关键的事：**Schema 依然是唯一真源，消解结果只是「值」。**
 * 字段结构、校验规则、组件类型全部来自原 Schema，
 * 我们只是往每个字段上挂了 default 和一片提示标签。
 */
function buildFormSchema(rawSchema: any, slots: SlotResult[]): any {
  const slotByField = new Map(slots.map((s) => [s.field, s]))

  const properties: Record<string, any> = {}
  for (const [field, def] of Object.entries<any>(rawSchema.properties ?? {})) {
    const slot = slotByField.get(field)
    const meta = slot ? sourceMeta(slot) : null

    const extra: any[] = []
    if (slot) {
      extra.push(
        <Tag
          key="src"
          color={meta!.color}
          style={{ marginInlineEnd: 4, fontSize: 11 }}
        >
          {meta!.text}
        </Tag>
      )
      if (slot.note) {
        extra.push(
          <span key="note" style={{ fontSize: 11, color: '#8c8c8c' }}>
            {slot.note}
          </span>
        )
      }
      if (slot.raw !== null && slot.raw !== undefined && String(slot.raw) !== String(slot.value)) {
        extra.push(
          <span key="raw" style={{ fontSize: 11, color: '#bfbfbf' }}>
            （原话：“{String(slot.raw)}”）
          </span>
        )
      }
    }

    const decoratorProps: Record<string, unknown> = {}
    if (extra.length) decoratorProps.extra = <span>{extra}</span>
    if (slot?.source === 'missing' && slot.required) {
      decoratorProps.feedbackStatus = 'error'
      decoratorProps.feedbackText = '必填'
    }

    properties[field] = {
      ...def,
      // 值注入：消解结果填进表单（推断值会被黄色标签标明，绝不静默）
      default: slot?.value ?? def.default,
      ...(Object.keys(decoratorProps).length
        ? { 'x-decorator-props': { ...(def['x-decorator-props'] ?? {}), ...decoratorProps } }
        : {}),
    }
  }

  return { ...rawSchema, properties }
}

export function ConfirmCard({
  schema,
  slots,
  title,
  verb,
  risk,
  question,
  revisesSeq,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const formSchema = useMemo(() => buildFormSchema(schema, slots), [schema, slots])

  const initialValues = useMemo(() => {
    const v: Record<string, unknown> = {}
    for (const s of slots) if (s.value !== null) v[s.field] = s.value
    return v
  }, [slots])

  const form = useMemo(
    () =>
      createForm({
        initialValues,
        effects() {},
      }),
    [initialValues]
  )

  const counts = {
    user: slots.filter((s) => s.source === 'user').length,
    inferred: slots.filter((s) => s.source === 'inferred').length,
    missing: slots.filter((s) => s.source === 'missing' && s.required).length,
  }

  return (
    <Card
      size="small"
      title={
        <Space size={6} wrap>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <code
            style={{
              fontSize: 11,
              background: '#f5f5f5',
              padding: '1px 6px',
              borderRadius: 4,
              color: '#595959',
            }}
          >
            {verb}
          </code>
          <Tag color={risk === 'write' ? 'volcano' : 'blue'} style={{ fontSize: 11 }}>
            {risk === 'write' ? '写入' : '只读'}
          </Tag>
          {revisesSeq !== undefined && (
            <Tag color="purple" style={{ fontSize: 11 }}>
              修订自 #{revisesSeq}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space size={4}>
          {counts.user > 0 && (
            <Tooltip title="你明确说出来的字段">
              <Tag color="green" style={{ fontSize: 11 }}>
                {counts.user} 项你说
              </Tag>
            </Tooltip>
          )}
          {counts.inferred > 0 && (
            <Tooltip title="系统推断的字段，落库前请复核">
              <Tag color="orange" style={{ fontSize: 11 }}>
                {counts.inferred} 项推断
              </Tag>
            </Tooltip>
          )}
          {counts.missing > 0 && (
            <Tag color="red" style={{ fontSize: 11 }}>
              {counts.missing} 项待补
            </Tag>
          )}
        </Space>
      }
      style={{ marginTop: 12 }}
    >
      {question && (
        <div
          style={{
            background: '#fffbe6',
            border: '1px solid #ffe58f',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 13,
            marginBottom: 12,
            color: '#ad6800',
          }}
        >
          {question}
        </div>
      )}

      {/* ↓↓↓ 地基验证点：这一行下面是零手写表单代码，全部由 JSON Schema 渲染 */}
      <FormProvider form={form}>
        <FormLayout layout="vertical" size="middle" colon={false}>
          <SchemaField schema={formSchema} />
        </FormLayout>
      </FormProvider>

      <Divider style={{ margin: '12px 0' }} />

      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        <Button onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <FormConsumer>
          {() => (
            <Button
              type="primary"
              danger={risk === 'write'}
              loading={submitting}
              onClick={() => onSubmit({ ...form.values })}
            >
              {submitLabel ?? (risk === 'write' ? `确认${title}` : '执行')}
            </Button>
          )}
        </FormConsumer>
      </Space>
    </Card>
  )
}
