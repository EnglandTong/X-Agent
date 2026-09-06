import { useState, useEffect, useRef } from 'react'
import { Input, Button, Tag, Space, Empty, Spin, Popconfirm, message } from 'antd'
import { SendOutlined, ClearOutlined, SettingOutlined, AudioOutlined } from '@ant-design/icons'
import { ConfirmCard } from './ConfirmCard'
import { PanelCard } from './PanelCard'
import { SettingsModal } from './SettingsModal'
import type { Panel, SlotResult, VerbResult } from '../types'

/** 活动格：还没提交的那一格，永远最多一个 */
interface Draft {
  verb: string
  title: string
  schema: any
  slots: SlotResult[]
  question?: string
  risk: 'read' | 'write'
  utterance: string
  supersedesId?: string
  /** 原地修订（仅草稿可用） */
  orderId?: string
  /** 变更单：指向原单号，两单各自独立存在 */
  originNo?: string
  revisesSeq?: number
  /** 这一格是谁抽的：rules 还是 llm */
  engine?: string
  llm?: { ms: number; error?: string; raw?: string }
}

const EXAMPLES = [
  { label: '完整流程', text: '给张三来120个A-100，下周三要' },
  { label: '重名歧义', text: '给张来50个B-200' },
  { label: '缺字段', text: '王五要C-300 20个' },
  { label: '只读查询', text: '查一下张三最近订单' },
]

export default function App() {
  const [panels, setPanels] = useState<Panel[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 当前 Agent 引擎，显示在底部标签上 —— 让人随时知道「现在是模型在猜还是规则在算」 */
  const [engine, setEngine] = useState<{ provider: string; model: string }>({
    provider: 'rules',
    model: '',
  })
  const canvasRef = useRef<HTMLDivElement>(null)
  const [listening, setListening] = useState(false)

  const scrollDown = () =>
    setTimeout(() => {
      canvasRef.current?.scrollTo({ top: canvasRef.current.scrollHeight, behavior: 'smooth' })
    }, 80)

  const reload = async () => {
    const r = await fetch('/api/panels').then((x) => x.json())
    setPanels(r)
    setLoading(false)
    scrollDown()
  }

  useEffect(() => {
    reload()
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => setEngine({ provider: s.provider, model: s.model }))
      .catch(() => {})
  }, [])

  /** 顶部上下文：取最近一格有业务对象的关联键 */
  const current = [...panels].reverse().find((p) => p.correlationId)

  // ---------------------------------------------------------------- 语音输入（Web Speech API → 同一条 interpret）

  function startVoice() {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      message.warning('当前浏览器不支持语音输入')
      return
    }
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.interimResults = false
    rec.maxAlternatives = 1
    setListening(true)
    rec.onresult = (ev: any) => {
      const text = String(ev.results?.[0]?.[0]?.transcript ?? '').trim()
      setListening(false)
      if (text) {
        setInput(text)
        send(text)
      }
    }
    rec.onerror = () => {
      setListening(false)
      message.error('语音识别失败')
    }
    rec.onend = () => setListening(false)
    rec.start()
  }

  // ---------------------------------------------------------------- 发送

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setInput('')
    try {
      const interp = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterance: text }),
      }).then((r) => r.json())

      if (interp.error) {
        message.error(interp.error)
        return
      }

      // 只读 + 无缺失 → 不必让人再点一次，直接跑
      if (interp.ready && interp.risk === 'read') {
        await execute(interp.verb, text, interp.slots)
        return
      }

      const schema = await fetch(`/api/schema/${interp.verb}`).then((r) => r.json())
      setDraft({
        verb: interp.verb,
        title: interp.verbTitle,
        schema,
        slots: interp.slots,
        question: interp.question,
        risk: interp.risk,
        utterance: text,
        engine: interp.engine,
        llm: interp.llm,
      })
      scrollDown()
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 执行

  async function execute(
    verb: string,
    utterance: string,
    slots: SlotResult[],
    values?: Record<string, unknown>,
    extra?: { supersedesId?: string; orderId?: string; originNo?: string }
  ) {
    setBusy(true)
    try {
      const args: Record<string, unknown> = { ...(values ?? {}) }
      for (const s of slots) {
        if (args[s.field] === undefined && s.value !== null) args[s.field] = s.value
      }
      if (extra?.orderId) args.orderId = extra.orderId
      if (extra?.originNo) args.originNo = extra.originNo
      args.__utterance =
        utterance ||
        (extra?.originNo
          ? `（变更自 ${extra.originNo}）`
          : extra?.supersedesId
            ? '（修订）'
            : null)

      const res = await fetch(`/api/verbs/${verb}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, slots, supersedesId: extra?.supersedesId ?? null }),
      }).then((r) => r.json())

      if (res.error) message.error(res.error)
      else if (res.ok) message.success(res.message)
      else message.warning(res.message)

      setDraft(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 修订

  async function revise(panel: Panel) {
    setBusy(true)
    try {
      const prep = await fetch(`/api/panels/${panel.id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.json())

      if (prep.error) {
        message.error(prep.error)
        return
      }
      // 分流：草稿原地改，已确认/已出货只能另开变更单
      const isDraft = prep.originStatus === 'DRAFT'
      const slots = isDraft
        ? prep.slots
        : prep.slots.map((s: SlotResult) =>
            s.slot === 'origin_no'
              ? { ...s, value: prep.originNo, label: prep.originNo, source: 'user' as const, note: '串联两单的关键词' }
              : s
          )

      setDraft({
        verb: prep.verb,
        title: isDraft ? `修订 ${prep.orderNo ?? prep.verb}` : `变更 ${prep.orderNo ?? prep.verb}`,
        schema: prep.schema,
        slots,
        risk: 'write',
        utterance: '',
        supersedesId: prep.supersedesId,
        orderId: isDraft ? prep.orderId : undefined,
        originNo: isDraft ? undefined : prep.originNo,
        revisesSeq: panel.seq,
      })
      message.info(
        isDraft
          ? `已带出 #${panel.seq} 的内容，提交后新开一格，原单 ${prep.orderNo} 原地更新`
          : `原单 ${prep.orderNo} 已确认不可改 → 将另开一张新单，通过「原单号」与之串联`
      )
      scrollDown()
    } finally {
      setBusy(false)
    }
  }

  /** 通用：按 Schema 开一格，prefill 是「字段名 → 值」 */
  async function openVerb(
    verb: string,
    prefill: Record<string, unknown>,
    title?: string
  ) {
    const schema = await fetch(`/api/schema/${verb}`).then((r) => r.json())
    const slots: SlotResult[] = Object.entries(schema.properties ?? {}).map(
      ([field, def]: [string, any]) => {
        const v = prefill[field]
        const filled = v !== undefined && v !== null && v !== ''
        return {
          slot: def['x-agent']?.extract ?? field,
          field,
          title: def.title ?? field,
          raw: filled ? v : null,
          value: filled ? v : null,
          label: filled ? String(v) : undefined,
          confidence: filled ? 0.99 : 0,
          source: (filled ? 'user' : 'missing') as SlotResult['source'],
          required: (schema.required ?? []).includes(field),
        }
      }
    )
    setDraft({
      verb,
      title: title ?? schema.title ?? verb,
      schema,
      slots,
      risk: schema['x-risk'] ?? 'write',
      utterance: '',
    })
    scrollDown()
  }

  async function clearCanvas() {
    await fetch('/api/panels', { method: 'DELETE' })
    setDraft(null)
    await reload()
  }

  // ---------------------------------------------------------------- 渲染

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        maxWidth: 560,
        margin: '0 auto',
        background: '#f0f2f5',
      }}
    >
      {/* 顶部：当前工作对象（跨格子共享上下文） */}
      <div
        style={{
          background: '#fff',
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#8c8c8c' }}>
          当前对象{' '}
          {current ? (
            <b style={{ color: '#1677ff' }}>
              {String(current.correlationId).replace(/^(ORD|CUS):/, '')}
            </b>
          ) : (
            '—'
          )}
        </span>
        <Space size={4}>
          <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>
            {panels.length} 格
          </Tag>
          <Button
            size="small"
            type="text"
            icon={<SettingOutlined />}
            onClick={() => setSettingsOpen(true)}
          />
          <Popconfirm title="清空整个画布？" onConfirm={clearCanvas} okText="清空" cancelText="取消">
            <Button size="small" type="text" icon={<ClearOutlined />} />
          </Popconfirm>
        </Space>
      </div>

      {/* 画布 */}
      <div ref={canvasRef} style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : panels.length === 0 && !draft ? (
          <Empty
            description={
              <span style={{ fontSize: 12 }}>
                画布是空的
                <br />
                在下面说一句话，就会画出第一格
              </span>
            }
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 60 }}
          />
        ) : null}

        {panels.map((p) => (
          <PanelCard
            key={p.id}
            panel={p}
            supersededBy={panels.find((x) => x.supersedesId === p.id)?.seq}
            revisesSeq={p.supersedesId ? panels.find((x) => x.id === p.supersedesId)?.seq : undefined}
            onRevise={revise}
            onConfirm={(p) => {
              const no = (p.result?.data as any)?.no
              if (no) openVerb('order.confirm', { orderNo: no }, `订单 ${no}`)
            }}
            busy={busy}
          />
        ))}

        {draft && (
          <div style={{ marginBottom: 6 }}>
            {draft.llm?.error ? (
              <Tag color="red" style={{ fontSize: 10 }}>
                模型失败已回落规则：{draft.llm.error}
              </Tag>
            ) : draft.engine === 'llm' ? (
              <Tag color="purple" style={{ fontSize: 10 }}>
                模型抽取 · {draft.llm?.ms ?? '—'}ms
              </Tag>
            ) : (
              <Tag style={{ fontSize: 10 }}>规则抽取</Tag>
            )}
          </div>
        )}
        {draft && (
          <ConfirmCard
            schema={draft.schema}
            slots={draft.slots}
            title={draft.title}
            verb={draft.verb}
            risk={draft.risk}
            question={draft.question}
            revisesSeq={draft.revisesSeq}
            submitLabel={
              draft.originNo
                ? '提交变更单'
                : draft.orderId
                  ? '提交修订'
                  : undefined
            }
            submitting={busy}
            onSubmit={(values) =>
              execute(draft.verb, draft.utterance, draft.slots, values, {
                supersedesId: draft.supersedesId,
                orderId: draft.orderId,
                originNo: draft.originNo,
              })
            }
            onCancel={() => setDraft(null)}
          />
        )}
      </div>

      {/* 底部：命令输入，永远在最下面 */}
      <div
        style={{
          background: '#fff',
          borderTop: '1px solid #e8e8e8',
          padding: '8px 12px 10px',
          flexShrink: 0,
        }}
      >
        <div style={{ overflowX: 'auto', whiteSpace: 'nowrap', marginBottom: 6 }}>
          <Space size={4}>
            {EXAMPLES.map((e) => (
              <Tag
                key={e.label}
                style={{ cursor: 'pointer', fontSize: 11, margin: 0 }}
                color="blue"
                onClick={() => send(e.text)}
              >
                {e.label}
              </Tag>
            ))}
            <Tag
              style={{ fontSize: 10, margin: 0, cursor: 'pointer', color: '#bfbfbf' }}
              onClick={() => setSettingsOpen(true)}
            >
              {engine.provider === 'openai' ? `模型 ${engine.model}` : '规则引擎'}
            </Tag>
          </Space>
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => send(input)}
            placeholder="说一句话，或点麦克风（同一条 interpret 链路）"
            disabled={busy}
            prefix={<span style={{ color: '#52c41a', fontWeight: 700 }}>›</span>}
          />
          <Button
            icon={<AudioOutlined />}
            loading={listening}
            disabled={busy}
            onClick={startVoice}
            title="语音输入"
          />
          <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => send(input)} />
        </Space.Compact>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setEngine({ provider: s.provider, model: s.model })
          message.success(
            s.provider === 'openai' ? `已切到模型 ${s.model}` : '已切回规则引擎（离线）'
          )
        }}
      />
    </div>
  )
}
