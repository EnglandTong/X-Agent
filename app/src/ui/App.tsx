import { useState, useEffect, useRef } from 'react'
import { Input, Button, Tag, Space, Empty, Spin, Popconfirm, message } from 'antd'
import {
  SendOutlined,
  ClearOutlined,
  SettingOutlined,
  AudioOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import { ConfirmCard } from './ConfirmCard'
import { PanelCard } from './PanelCard'
import { SettingsModal } from './SettingsModal'
import { startRecording, type RecordHandle, type Recording } from './voiceRecorder'
import type { Panel, SlotResult, VerbResult } from '../types'

/** 活动格：还没提交的那一格，永远最多一个（且只属于当前工作页） */
interface Draft {
  verb: string
  title: string
  schema: any
  slots: SlotResult[]
  question?: string
  risk: 'read' | 'write'
  utterance: string
  supersedesId?: string
  orderId?: string
  originNo?: string
  revisesSeq?: number
  engine?: string
  llm?: { ms: number; error?: string; raw?: string }
}

interface WorkSession {
  sessionId: string
  title: string
  panelCount: number
  correlationId: string | null
}

interface LexPropose {
  phrase: string
  kind: 'verb' | 'slot'
  verb?: string
  slot?: string
  targetId?: string
  targetLabel?: string
  targetRaw?: string
}

const EXAMPLES = [
  { label: '完整流程', text: '给张三来120个A-100，下周三要' },
  { label: '重名歧义', text: '给张来50个B-200' },
  { label: '缺字段', text: '王五要C-300 20个' },
  { label: '只读查询', text: '查一下张三最近订单' },
]

const CONTINUE_VERBS = new Set([
  'order.confirm',
  'order.cancel',
  'order.query',
  'delivery.create',
  'delivery.confirm',
  'delivery.query',
  'inventory.query',
  'inventory.reserve',
  'inventory.release',
  'customer.query',
  'credit.check',
])

function newSessionId() {
  return `work-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function mergeSessionLists(prev: WorkSession[], incoming: WorkSession[]): WorkSession[] {
  const map = new Map<string, WorkSession>()
  for (const s of prev) map.set(s.sessionId, s)
  for (const s of incoming) {
    const old = map.get(s.sessionId)
    if (!old || s.panelCount >= old.panelCount) map.set(s.sessionId, s)
  }
  return [...map.values()].sort((a, b) => {
    // 有内容的在前，其次保持 incoming 顺序近似（新的在前）
    if (a.panelCount === 0 && b.panelCount > 0) return 1
    if (b.panelCount === 0 && a.panelCount > 0) return -1
    return 0
  })
}

function titleFromPanels(panels: Panel[]): string {
  const last = [...panels].reverse()[0]
  if (!last) return '工作'
  const no = (last.result?.data as any)?.no
  const customer = (last.result?.data as any)?.customer
  if (no) return String(no)
  if (customer) return String(customer)
  if (last.utterance) return last.utterance.slice(0, 16)
  return last.title || last.verb || '工作'
}

export default function App() {
  const [sessionId, setSessionId] = useState('default')
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [panels, setPanels] = useState<Panel[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [engine, setEngine] = useState<{ provider: string; model: string }>({
    provider: 'rules',
    model: '',
  })
  const canvasRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(sessionId)
  const panelsRef = useRef(panels)
  const [listening, setListening] = useState(false)
  const [lexProposals, setLexProposals] = useState<LexPropose[]>([])
  const [ttsEnabled, setTtsEnabled] = useState(true)
  /** 耳朵用哪只：不 import 服务端类型，免得前端反向依赖 server */
  const [asrEngine, setAsrEngine] = useState<'browser' | 'local'>('browser')
  const [asrState, setAsrState] = useState('unloaded')
  /** 刚才那段录音（供「存为语料」用）；null = 没有可存的 */
  const [lastRecording, setLastRecording] = useState<{ wav: ArrayBuffer; id: string } | null>(null)
  /** 录音句柄放 ref：它变化不该触发重渲染 */
  const recorderRef = useRef<RecordHandle | null>(null)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    panelsRef.current = panels
  }, [panels])

  const scrollDown = () =>
    setTimeout(() => {
      canvasRef.current?.scrollTo({ top: canvasRef.current.scrollHeight, behavior: 'smooth' })
    }, 80)

  /**
   * 让系统开口（「嘴」→ /api/speak）。火后即忘：
   * 播报要几秒、还可能没有声卡 —— 这些都不能拖住画布。
   */
  function say(text?: string | null) {
    const t = (text ?? '').trim()
    // 正在录音时不开口：会把播报自己录进麦克风（外放时 AEC 压不干净）
    if (!ttsEnabled || !t || listening) return
    void fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t.slice(0, 300) }),
    }).catch(() => {})
  }

  /** 离开当前页之前：把本页登记进 Tab 列表（即使还没重新拉 API） */
  function parkCurrentSession(override?: { sessionId: string; panels: Panel[] }) {
    const sid = override?.sessionId ?? sessionIdRef.current
    const ps = override?.panels ?? panelsRef.current
    if (!ps.length) return
    const snap: WorkSession = {
      sessionId: sid,
      title: titleFromPanels(ps),
      panelCount: ps.length,
      correlationId: [...ps].reverse().find((p) => p.correlationId)?.correlationId ?? null,
    }
    setSessions((prev) => mergeSessionLists(prev, [snap]))
  }

  const reloadSessions = async () => {
    try {
      const res = await fetch('/api/sessions')
      const list = await res.json()
      if (Array.isArray(list)) {
        setSessions((prev) => mergeSessionLists(prev, list))
      }
    } catch {
      /* 保留本地 Tab，不因接口失败清空 */
    }
  }

  const reload = async (sid = sessionIdRef.current) => {
    const r = await fetch(`/api/panels?sessionId=${encodeURIComponent(sid)}`).then((x) =>
      x.json()
    )
    setPanels(Array.isArray(r) ? r : [])
    await reloadSessions()
    setLoading(false)
    scrollDown()
  }

  useEffect(() => {
    reload('default')
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        setEngine({ provider: s.provider, model: s.model })
        setTtsEnabled(s.ttsEnabled !== false)
        setAsrEngine(s.asrEngine === 'local' ? 'local' : 'browser')
        setAsrState(s.asr?.state ?? 'unloaded')
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setLoading(true)
    reload(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const current = [...panels].reverse().find((p) => p.correlationId)

  /** 同一链路继续留下；「新开一张业务单」且当前页已有内容 → 新工作页（旧页变 Tab） */
  function shouldOpenNewWork(
    verb: string,
    panelCount: number,
    extra?: { originNo?: string; orderId?: string; supersedesId?: string }
  ) {
    if (panelCount === 0) return false
    if (extra?.originNo || extra?.orderId || extra?.supersedesId) return false
    if (CONTINUE_VERBS.has(verb)) return false
    return verb === 'order.create'
  }

  /** 开新页：先把旧页钉在 Tab 上，再切换 —— 绝不删库 */
  function openNewWorkPage(reason?: string): string {
    parkCurrentSession()
    const sid = newSessionId()
    // 先登记空的新页，保证 Tab 上立刻能看到「新旧两个」
    setSessions((prev) =>
      mergeSessionLists(prev, [
        {
          sessionId: sid,
          title: '新工作',
          panelCount: 0,
          correlationId: null,
        },
      ])
    )
    setDraft(null)
    setPanels([])
    setSessionId(sid)
    sessionIdRef.current = sid
    panelsRef.current = []
    if (reason) message.info(reason)
    else message.success('已新开工作页；旧工作在上方 Tab')
    return sid
  }

  function startNewWork() {
    openNewWorkPage()
  }

  function switchSession(sid: string) {
    if (sid === sessionIdRef.current) return
    // 切换走之前也钉一下当前页，避免空窗期 Tab 丢
    parkCurrentSession()
    setDraft(null)
    setSessionId(sid)
  }

  // ---------------------------------------------------------------- 语音

  /** 服务端 reason 是机器码，这里翻成人话（不然 Owner 只能看到 bad_wav 这种词） */
  const ASR_REASON: Record<string, string> = {
    model_missing: '没找到 SenseVoice 权重（见 app/models/OFFLINE_BUNDLE.md），可先切回浏览器引擎',
    loading: '模型还在加载（约 1 秒），请再说一次',
    unsupported: '本地引擎目前只在 win32-x64 验过，请切回浏览器引擎',
    engine_unavailable: '本地引擎起不来，去设置面板点「自检」看原因',
    too_long: '这句太长了（上限 15 秒）',
    busy: '上一条还在识别，稍等再说',
    bad_wav: '没听清（录音没成 WAV）',
    decode_failed: '识别失败，可切回浏览器引擎',
  }

  /** 再点一次 = 停下并送识别（本地引擎需要有人收尾取结果） */
  function startVoice() {
    if (listening) {
      if (recorderRef.current) void finishVoiceLocal()
      return // 浏览器引擎自己会 onend，不替它管
    }
    if (asrEngine === 'local') void startVoiceLocal()
    else startVoiceBrowser()
  }

  /** 浏览器 Web Speech —— 本轮的回退锚点，函数体与接线前一字不差 */
  function startVoiceBrowser() {
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

  async function startVoiceLocal() {
    setListening(true)
    try {
      recorderRef.current = await startRecording({
        maxSeconds: 15,
        onAutoStop: () => void finishVoiceLocal(), // 撞到上限也要有人收尾
      })
    } catch (e: any) {
      setListening(false)
      message.error(e?.message ?? '无法开始录音')
    }
  }

  /** 停录 → 送识别 → 走同一条 send() */
  async function finishVoiceLocal() {
    const handle = recorderRef.current
    recorderRef.current = null
    if (!handle) return

    let rec: Recording
    try {
      rec = await handle.stop()
    } catch {
      setListening(false)
      message.error('录音没收住')
      return
    }
    setListening(false)
    if (rec.capped) message.info('已到 15 秒上限，先按这段识别')
    // 授权弹窗期是静音；不拦就会拿空串去 /api/interpret 换 400，症状是「点了没反应」
    if (rec.peak < 0.003) {
      message.warning('没听到声音（查麦克风，或切回浏览器引擎）')
      return
    }

    const id = `real-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`
    setLastRecording({ wav: rec.wav, id })

    try {
      const r = await fetch('/api/asr', {
        method: 'POST',
        // 不写这一行 fetch 不会带 Content-Type，Fastify 直接 415
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rec.wav,
      })
      const j = await r.json()
      if (j.ok && j.text) {
        setInput(j.text)
        send(j.text)
      } else if (j.ok) {
        message.warning('听到了，但没识别出字')
      } else {
        // 绝不偷偷改用浏览器引擎重听一遍：那会让人分不清是哪只耳朵听错的字
        message.warning(ASR_REASON[j.reason ?? j.skipped ?? ''] ?? j.reason ?? '识别失败')
      }
    } catch {
      message.error('识别请求没送到服务（服务起了吗？）')
    }
  }

  /** 把刚才那段真人录音存成语料 —— 只有它才能让 CER 不再是合成语音的数字 */
  async function saveCorpus() {
    if (!lastRecording) return
    try {
      const r = await fetch(`/api/asr/corpus/${lastRecording.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: lastRecording.wav,
      })
      const j = await r.json()
      if (r.ok && j.ok) {
        message.success(`已存为语料 ${j.path}`)
        setLastRecording(null)
      } else {
        message.warning(j.error ?? '没能存下')
      }
    } catch {
      message.error('存语料请求失败')
    }
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

      // 新工作：当前页已有链路，又来一张全新建单 → 旧页钉成 Tab，再开新页
      let sid = sessionIdRef.current
      if (shouldOpenNewWork(interp.verb, panelsRef.current.length)) {
        sid = openNewWorkPage('已开新工作页；旧工作保留在上方 Tab')
      }

      if (interp.ready && interp.risk === 'read') {
        await execute(interp.verb, text, interp.slots, undefined, undefined, sid)
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
      // 还没问完 → 直接念出来（语音场景下，人不必盯着屏幕看追问）
      say(interp.question)
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
    extra?: { supersedesId?: string; orderId?: string; originNo?: string },
    forcedSessionId?: string
  ) {
    setBusy(true)
    try {
      let sid = forcedSessionId ?? sessionIdRef.current
      if (
        !forcedSessionId &&
        shouldOpenNewWork(verb, panelsRef.current.length, extra)
      ) {
        sid = openNewWorkPage('已开新工作页；旧工作保留在上方 Tab')
      }

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
        body: JSON.stringify({
          args,
          slots,
          supersedesId: extra?.supersedesId ?? null,
          sessionId: sid,
        }),
      }).then((r) => r.json())

      if (res.error) {
        message.error(res.error)
        say(res.error)
      } else if (res.ok) {
        message.success(res.message)
        say(res.message)
        // 确认后提议记住（改过预填或曾歧义）—— 未同意不入库
        try {
          const prop = await fetch('/api/lexicon/propose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              utterance,
              verb,
              slots,
              submittedValues: values ?? {},
            }),
          }).then((r) => r.json())
          if (Array.isArray(prop.proposals) && prop.proposals.length) {
            setLexProposals(prop.proposals)
          }
        } catch {
          /* 提议失败不影响主流程 */
        }
      } else {
        message.warning(res.message)
        say(res.message)
      }

      setDraft(null)
      sessionIdRef.current = sid
      if (sid !== sessionId) setSessionId(sid)
      await reload(sid)
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 修订（留在同一工作页）

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
      const isDraft = prep.originStatus === 'DRAFT'
      const slots = isDraft
        ? prep.slots
        : prep.slots.map((s: SlotResult) =>
            s.slot === 'origin_no'
              ? {
                  ...s,
                  value: prep.originNo,
                  label: prep.originNo,
                  source: 'user' as const,
                  note: '串联两单的关键词',
                }
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
          ? `已带出 #${panel.seq} 的内容，仍在本工作页继续`
          : `原单 ${prep.orderNo} 已确认 → 变更单仍在本工作页串联`
      )
      scrollDown()
    } finally {
      setBusy(false)
    }
  }

  async function openVerb(verb: string, prefill: Record<string, unknown>, title?: string) {
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
    const sid = sessionIdRef.current
    await fetch(`/api/panels?sessionId=${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    })
    setDraft(null)
    setSessions((prev) =>
      prev.map((s) => (s.sessionId === sid ? { ...s, panelCount: 0, title: '空工作页' } : s))
    )
    await reload(sid)
  }

  // Tab 栏：合并本地登记 + 当前页，旧页不会因为切走而消失
  const tabList: WorkSession[] = mergeSessionLists(sessions, [
    {
      sessionId,
      title: panels.length ? titleFromPanels(panels) : '新工作',
      panelCount: panels.length,
      correlationId: current?.correlationId ?? null,
    },
  ])

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
      {/* 工作页 Tab：同一链路往下堆；新要求开新页，旧页收成 Tab */}
      <div
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          padding: '6px 8px 0',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 4,
          overflowX: 'auto',
        }}
      >
        {tabList.map((s) => {
          const active = s.sessionId === sessionId
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => switchSession(s.sessionId)}
              style={{
                border: '1px solid #e8e8e8',
                borderBottom: active ? '1px solid #fff' : '1px solid #e8e8e8',
                background: active ? '#fff' : '#fafafa',
                borderRadius: '6px 6px 0 0',
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: active ? '#1677ff' : '#595959',
                fontWeight: active ? 600 : 400,
                marginBottom: active ? -1 : 0,
              }}
              title={s.title}
            >
              {s.title}
              {s.panelCount > 0 ? (
                <span style={{ color: '#bfbfbf', marginLeft: 4 }}>{s.panelCount}</span>
              ) : null}
            </button>
          )
        })}
        <Button
          size="small"
          type="text"
          icon={<PlusOutlined />}
          onClick={startNewWork}
          title="新开一个工作页"
          style={{ marginBottom: 2 }}
        />
      </div>

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
          <Popconfirm
            title="清空当前工作页？"
            description="其它 Tab 里的旧工作不会被删"
            onConfirm={clearCanvas}
            okText="清空本页"
            cancelText="取消"
          >
            <Button size="small" type="text" icon={<ClearOutlined />} />
          </Popconfirm>
        </Space>
      </div>

      <div ref={canvasRef} style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : panels.length === 0 && !draft ? (
          <Empty
            description={
              <span style={{ fontSize: 12 }}>
                本工作页是空的
                <br />
                说一句话开始；再开一张新单会自动新开一页
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

        {lexProposals.length > 0 && (
          <div
            style={{
              background: '#f6ffed',
              border: '1px solid #b7eb8f',
              borderRadius: 6,
              padding: '8px 10px',
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            <div style={{ marginBottom: 6, color: '#389e0d' }}>要记住这些习惯说法吗？</div>
            {lexProposals.map((p, i) => (
              <div
                key={`${p.phrase}-${i}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span>
                  「{p.phrase}」→ {p.targetLabel ?? p.verb ?? p.slot}
                </span>
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    onClick={async () => {
                      await fetch('/api/lexicon', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...p, source: 'confirmed' }),
                      })
                      setLexProposals((prev) => prev.filter((_, j) => j !== i))
                      message.success('已记住')
                    }}
                  >
                    记住
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    onClick={async () => {
                      await fetch('/api/lexicon', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          phrase: p.phrase,
                          kind: p.kind,
                          slot: p.slot,
                          verb: p.verb,
                          targetId: p.targetId,
                          targetLabel: p.targetLabel,
                          source: 'confirmed',
                          status: 'rejected',
                        }),
                      })
                      setLexProposals((prev) => prev.filter((_, j) => j !== i))
                    }}
                  >
                    忽略
                  </Button>
                </Space>
              </div>
            ))}
            <Button size="small" type="text" onClick={() => setLexProposals([])}>
              全部忽略
            </Button>
          </div>
        )}

        {draft && (
          <div style={{ marginBottom: 6 }}>
            {draft.llm?.error ? (
              <Tag color="red" style={{ fontSize: 10 }}>
                模型失败已回落规则：{draft.llm.error}
              </Tag>
            ) : draft.engine === 'llm' || draft.engine === 'pi' ? (
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
            utterance={draft.utterance}
            revisesSeq={draft.revisesSeq}
            submitLabel={
              draft.originNo ? '提交变更单' : draft.orderId ? '提交修订' : undefined
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
            placeholder="同一链路继续说；新开一张单会自动新开工作页"
            disabled={busy}
            prefix={<span style={{ color: '#52c41a', fontWeight: 700 }}>›</span>}
          />
          <Button
            icon={<AudioOutlined />}
            loading={listening}
            disabled={busy}
            onClick={startVoice}
            title={
              asrEngine === 'local'
                ? `语音输入 · 本地 SenseVoice（${asrState}）`
                : '语音输入 · 浏览器 Web Speech'
            }
          />
          {lastRecording && (
            <Button icon={<SaveOutlined />} onClick={saveCorpus} title="把刚才这段真人录音存成语料（进 npm run asr:cer）" />
          )}
          <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => send(input)} />
        </Space.Compact>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setEngine({ provider: s.provider, model: s.model })
          setTtsEnabled(s.ttsEnabled !== false)
          setAsrEngine(s.asrEngine === 'local' ? 'local' : 'browser')
          setAsrState(s.asr?.state ?? 'unloaded')
          message.success(
            s.provider === 'openai' ? `已切到模型 ${s.model}` : '已切回规则引擎（离线）'
          )
        }}
      />
    </div>
  )
}
