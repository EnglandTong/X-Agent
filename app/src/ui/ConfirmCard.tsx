import { useMemo, useState } from 'react'
import { createForm } from '@formily/core'
import { FormProvider, FormConsumer } from '@formily/react'
import { FormLayout } from '@formily/antd-v5'
import { Card, Tag, Button, Space, Divider, Tooltip, message } from 'antd'
import { SchemaField } from './formily'
import type { SlotResult } from '../types'

interface Props {
  schema: any
  slots: SlotResult[]
  title: string
  verb: string
  risk: 'read' | 'write'
  question?: string
  utterance?: string
  /** 非空表示这是从 #N 修订而来的新格 */
  revisesSeq?: number
  /** 覆盖默认提交文案（变更单 / 修订） */
  submitLabel?: string
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
    // 隐藏字段（如多行 items）不进确认表单；仍由 slots → args 带入执行
    if (def['x-hidden']) continue
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
      decoratorProps.feedbackText = '必填 — 请在下方选择或填写'
    }

    // 有歧义候选时：强制用下拉，选项就是候选（绝不自动选中）
    const componentProps: Record<string, unknown> = {
      ...(def['x-component-props'] ?? {}),
    }
    let xComponent = def['x-component']
    if (slot?.candidates?.length) {
      xComponent =
        field === 'customerId'
          ? 'CustomerSelect'
          : field === 'productId'
            ? 'ProductSelect'
            : 'Select'
      componentProps.options = slot.candidates.map((c) => ({
        value: c.id,
        label: c.hint ? `${c.label} · ${c.hint}` : c.label,
      }))
      componentProps.placeholder = `请选择（${slot.candidates.length} 个候选）`
      componentProps.allowClear = true
    }

    properties[field] = {
      ...def,
      'x-component': xComponent,
      'x-component-props': componentProps,
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
  utterance,
  revisesSeq,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const formSchema = useMemo(() => buildFormSchema(schema, slots), [schema, slots])
  const [remembering, setRemembering] = useState(false)

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

  const rememberableSlots = slots.filter(
    (s) =>
      (s.slot === 'customer' || s.slot === 'product') &&
      s.raw != null &&
      String(s.raw).trim().length >= 2 &&
      s.value != null
  )

  const verbPhrase = utterance?.trim() ?? ''
  const canRememberVerb = verbPhrase.length >= 2 && verbPhrase.length <= 16

  /** 默认：只记槽位 raw（客户/产品） */
  async function rememberSlots() {
    if (!rememberableSlots.length) {
      message.info('没有可记住的客户/产品说法')
      return
    }
    const values = { ...form.values }
    setRemembering(true)
    try {
      for (const s of rememberableSlots) {
        const targetId = values[s.field] ?? s.value
        if (targetId == null || targetId === '') continue
        await fetch('/api/lexicon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phrase: String(s.raw).trim(),
            kind: 'slot',
            slot: s.slot,
            targetId: String(targetId),
            targetLabel: s.label ?? String(targetId),
            targetRaw: String(s.raw),
            source: 'explicit',
          }),
        })
      }
      message.success('已记住客户/产品说法')
    } catch (e: any) {
      message.error(String(e?.message ?? e))
    } finally {
      setRemembering(false)
    }
  }

  /** 可选：短句记为动词说法（≤16 字，避免整句垃圾） */
  async function rememberAsVerb() {
    if (!canRememberVerb) {
      message.info('开单说法须为 2–16 个字')
      return
    }
    setRemembering(true)
    try {
      await fetch('/api/lexicon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phrase: verbPhrase,
          kind: 'verb',
          verb,
          source: 'explicit',
        }),
      })
      message.success('已记住为开单说法')
    } catch (e: any) {
      message.error(String(e?.message ?? e))
    } finally {
      setRemembering(false)
    }
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

      <FormProvider form={form}>
        <FormLayout layout="vertical" size="large" colon={false}>
          <SchemaField schema={formSchema} />
        </FormLayout>
      </FormProvider>

      <Divider style={{ margin: '12px 0' }} />

      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space size={0} wrap>
          <Button
            size="small"
            type="link"
            loading={remembering}
            disabled={submitting || !rememberableSlots.length}
            onClick={rememberSlots}
            title="只记住客户/产品槽位说法"
          >
            记住这个说法
          </Button>
          <Button
            size="small"
            type="link"
            loading={remembering}
            disabled={submitting || !canRememberVerb}
            onClick={rememberAsVerb}
            title="把短句（≤16字）记为动词说法"
            style={{ color: '#8c8c8c' }}
          >
            记住为开单说法
          </Button>
        </Space>
        <Space>
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
      </Space>
    </Card>
  )
}
