import { useState, useEffect } from 'react'
import {
  Modal,
  Form,
  Input,
  Radio,
  AutoComplete,
  InputNumber,
  Button,
  Space,
  Alert,
  Tag,
  Spin,
  Typography,
} from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'

interface SettingsView {
  provider: 'rules' | 'openai'
  baseUrl: string
  model: string
  timeoutMs: number
  apiKey: string
  hasKey: boolean
  presets: string[]
  localQwen06?: {
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    timeoutMs: number
  }
  enginePriority?: string
}

interface TestResult {
  ok: boolean
  ms: number
  model: string
  baseUrl: string
  error?: string
  detail?: string
}

export function SettingsModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (s: SettingsView) => void
}) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [base, setBase] = useState<SettingsView | null>(null)
  const provider = Form.useWatch('provider', form)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setTest(null)
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: SettingsView) => {
        setBase(s)
        form.setFieldsValue({
          provider: s.provider,
          baseUrl: s.baseUrl,
          model: s.model,
          timeoutMs: s.timeoutMs,
          apiKey: s.apiKey, // 掩码；不修改就原样回传
        })
      })
      .finally(() => setLoading(false))
  }, [open, form])

  async function save(withTest = false) {
    const v = await form.validateFields().catch(() => null)
    if (!v) return

    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      }).then((r) => r.json())
      if (res.error) {
        setTest({ ok: false, ms: 0, model: v.model, baseUrl: v.baseUrl, error: res.error })
        return
      }
      onSaved(res)
      if (withTest) await runTest()
      else onClose()
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      const r = await fetch('/api/settings/test', { method: 'POST' }).then((x) => x.json())
      setTest(r)
    } catch (e: any) {
      setTest({ ok: false, ms: 0, model: '', baseUrl: '', error: String(e?.message ?? e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={<span style={{ fontSize: 14 }}>模型设置</span>}
      open={open}
      onCancel={onClose}
      width={420}
      maskClosable={false}
      footer={
        <Space>
          <Button
            size="small"
            onClick={() => save(true)}
            disabled={loading || provider !== 'openai'}
          >
            保存并测试
          </Button>
          <Button size="small" onClick={() => save(false)} loading={saving}>
            仅保存
          </Button>
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 30 }}>
          <Spin />
        </div>
      ) : (
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="provider" label={<span style={{ fontSize: 12 }}>Agent 引擎</span>}>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: '规则回落', value: 'rules' },
                { label: 'LLM 大脑', value: 'openai' },
              ]}
            />
          </Form.Item>
          {base?.enginePriority && (
            <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: -8, marginBottom: 8 }}>
              优先级：{base.enginePriority}
            </div>
          )}

          {provider === 'openai' && (
            <>
              {base?.localQwen06 && (
                <Button
                  size="small"
                  type="dashed"
                  block
                  style={{ marginBottom: 12 }}
                  onClick={() => {
                    const p = base.localQwen06!
                    form.setFieldsValue({
                      provider: 'openai',
                      baseUrl: p.baseUrl,
                      apiKey: p.apiKey,
                      model: p.model,
                      timeoutMs: p.timeoutMs,
                    })
                  }}
                >
                  可选·暂缓：本地 Qwen3-0.6B（现阶请用云端）
                </Button>
              )}
              <Form.Item
                name="baseUrl"
                label={<span style={{ fontSize: 12 }}>接口地址（OpenAI 兼容）</span>}
                rules={[{ required: true, message: '必填' }]}
                extra={
                  <span style={{ fontSize: 11 }}>
                    云端：火山 ark…/api/v3 · 本地：http://127.0.0.1:11434/v1
                  </span>
                }
              >
                <Input placeholder="https://ark.cn-beijing.volces.com/api/v3" />
              </Form.Item>

              <Form.Item
                name="apiKey"
                label={<span style={{ fontSize: 12 }}>API Key</span>}
                rules={[{ required: true, message: '必填' }]}
                extra={
                  <span style={{ fontSize: 11 }}>
                    存在服务端 .env.local，不进 git、不进对话记录
                    {base?.hasKey ? ' · 已保存，不改就别动这行' : ''}
                  </span>
                }
              >
                <Input.Password placeholder="填进去之后前端只显示掩码" autoComplete="off" />
              </Form.Item>

              <Form.Item
                name="model"
                label={<span style={{ fontSize: 12 }}>模型</span>}
                rules={[{ required: true, message: '必填' }]}
              >
                <AutoComplete
                  options={(base?.presets ?? []).map((m) => ({ value: m }))}
                  filterOption={(input, option) =>
                    String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>

              <Form.Item
                name="timeoutMs"
                label={<span style={{ fontSize: 12 }}>超时（毫秒）</span>}
              >
                <InputNumber min={3000} max={120000} step={1000} style={{ width: '100%' }} />
              </Form.Item>

              <div style={{ marginBottom: 12 }}>
                <Button size="small" onClick={runTest} loading={testing} block>
                  测试连接
                </Button>
              </div>

              {test && (
                <Alert
                  style={{ marginBottom: 12 }}
                  type={test.ok ? 'success' : 'error'}
                  icon={test.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                  message={
                    <span style={{ fontSize: 12 }}>
                      {test.ok ? (
                        <>
                          连通 · {test.model} · {test.ms}ms
                        </>
                      ) : (
                        <>{test.error}</>
                      )}
                    </span>
                  }
                  description={
                    test.detail ? (
                      <Typography.Paragraph
                        style={{ fontSize: 10, marginBottom: 0, whiteSpace: 'pre-wrap' }}
                        ellipsis={{ rows: 4, tooltip: test.detail }}
                      >
                        {test.detail}
                      </Typography.Paragraph>
                    ) : null
                  }
                />
              )}

              <Tag color="blue" style={{ fontSize: 10 }}>
                模型只做听写：输出原话片段，日期/数字/ID 一律交给确定性代码
              </Tag>
            </>
          )}
        </Form>
      )}
    </Modal>
  )
}
