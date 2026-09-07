/**
 * SenseVoice / sherpa-onnx CER 脚手架
 *
 * 正式跑通需本机：
 *   1. 下载 sherpa-onnx SenseVoice int8 到 app/models/asr/sensevoice/
 *   2. 安装 sherpa-onnx CLI 或 Python 绑定，并设置环境变量 SHERPA_ASR_CMD
 *
 * 无权重时：用「假 ASR=期望文本」跑通评测管线，并打印跳过原因。
 *
 *   npm run hotwords
 *   npm run asr:cer
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EVAL = join(ROOT, 'eval')
const ASR_DIR = join(ROOT, 'models/asr')
const RESULTS = join(EVAL, 'results')

interface Sample {
  id: string
  /** 期望转写（黄金文本） */
  text: string
  /** 可选：wav 相对路径；无则跳过真实 ASR */
  wav?: string
}

function loadSamples(): Sample[] {
  const path = join(EVAL, 'asr-utterances.jsonl')
  if (!existsSync(path)) {
    // 从主数据热词拼最小集
    const hw = join(ASR_DIR, 'hotwords.txt')
    const words = existsSync(hw)
      ? readFileSync(hw, 'utf-8').split(/\r?\n/).filter(Boolean).slice(0, 10)
      : ['张三', 'A-100', '华东仓']
    return words.map((w, i) => ({
      id: `asr-${i + 1}`,
      text: `给${w}来10个`,
    }))
  }
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sample)
}

/** 极简字错率：1 - 最长公共子序列/期望长 */
function cer(ref: string, hyp: string): number {
  const a = [...ref.replace(/\s/g, '')]
  const b = [...hyp.replace(/\s/g, '')]
  if (!a.length) return b.length ? 1 : 0
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const lcs = dp[a.length][b.length]
  return 1 - lcs / a.length
}

function runSherpa(wav: string): string | null {
  const cmd = process.env.SHERPA_ASR_CMD
  if (!cmd) return null
  // SHERPA_ASR_CMD 例: sherpa-onnx-offline --model=... --tokens=...
  const r = spawnSync(cmd, [wav], { encoding: 'utf-8', shell: true })
  if (r.status !== 0) {
    console.warn('sherpa failed', r.stderr)
    return null
  }
  return (r.stdout || '').trim()
}

async function main() {
  mkdirSync(RESULTS, { recursive: true })
  const samples = loadSamples()
  const modelOnnx = join(ASR_DIR, 'sensevoice/model.int8.onnx')
  const hasModel = existsSync(modelOnnx)
  const hasCmd = Boolean(process.env.SHERPA_ASR_CMD)

  console.log(`样本 ${samples.length} · 权重 ${hasModel ? '有' : '无'} · CLI ${hasCmd ? '有' : '无'}`)

  if (!hasModel || !hasCmd) {
    console.log(`
⚠️  CER 真实推理未跑（缺权重或 SHERPA_ASR_CMD）。
   请按 app/models/OFFLINE_BUNDLE.md 下载 SenseVoice int8，
   并设置 SHERPA_ASR_CMD 指向 sherpa-onnx 离线识别命令。
   热词文件：${join(ASR_DIR, 'hotwords.txt')}
`)
    writeFileSync(
      join(RESULTS, 'asr-cer.md'),
      `# ASR CER\n\n状态：脚手架就位，**待权重**。\n热词：\`models/asr/hotwords.txt\`\n`,
      'utf-8'
    )
    process.exit(0)
  }

  const rows: { id: string; ref: string; hyp: string; cer: number }[] = []
  for (const s of samples) {
    if (!s.wav || !existsSync(s.wav)) {
      console.log(`skip ${s.id}（无 wav）`)
      continue
    }
    const hyp = runSherpa(s.wav) ?? ''
    const c = cer(s.text, hyp)
    rows.push({ id: s.id, ref: s.text, hyp, cer: c })
    console.log(`${s.id} CER=${(c * 100).toFixed(1)}%  hyp=${hyp}`)
  }

  const avg = rows.length ? rows.reduce((a, r) => a + r.cer, 0) / rows.length : null
  const md = `# ASR CER

生成：${new Date().toISOString()}
平均 CER：${avg == null ? '—' : (avg * 100).toFixed(2) + '%'}
门槛建议：专有名词命中优先；整体 CER 需人工看种子名/料号。

| id | CER | ref | hyp |
|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${(r.cer * 100).toFixed(1)}% | ${r.ref} | ${r.hyp} |`).join('\n')}
`
  writeFileSync(join(RESULTS, 'asr-cer.md'), md, 'utf-8')
  console.log(md)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
