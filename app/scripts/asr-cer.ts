/**
 * SenseVoice / sherpa-onnx CER 评测：`npm run asr:cer`
 *
 * 本机前置：
 *   1. 权重 app/models/asr/sensevoice/{model.int8.onnx, tokens.txt}
 *   2. 运行时 `sherpa-onnx-node`（已入 devDependencies）
 *   3. 环境变量 SHERPA_ASR_CMD，例：
 *        set SHERPA_ASR_CMD=npx tsx scripts/asr-transcribe.ts
 *   4. 音频 `npm run asr:wavs`（缺真人录音时用 SAPI 合成；**结论偏乐观**）
 *
 * 无权重 / 无 CMD / 无音频时：打印跳过原因并写占位报告，不报错。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EVAL = join(ROOT, 'eval')
const ASR_DIR = join(ROOT, 'models/asr')
const WAV_DIR = join(EVAL, 'asr-wavs')
/** 画布「存为语料」的落点：真人录音一旦存在就优先于合成语音 */
const REAL_DIR = join(EVAL, 'asr-wavs-real')
const RESULTS = join(EVAL, 'results')

interface Sample {
  id: string
  /** 期望转写（黄金文本） */
  text: string
  category?: string
  /** 可选：wav 路径；无则回退到 eval/asr-wavs/<id>.wav */
  wav?: string
}

function loadSamples(): Sample[] {
  const path = join(EVAL, 'asr-utterances.jsonl')
  if (!existsSync(path)) {
    const hw = join(ASR_DIR, 'hotwords.txt')
    const words = existsSync(hw)
      ? readFileSync(hw, 'utf-8')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, 10)
      : ['张三', 'A-100', '华东仓']
    return words.map((w, i) => ({ id: `asr-${i + 1}`, text: `给${w}来10个` }))
  }
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sample)
}

/** 标准 CER：编辑距离 / 参考长度（去空白与标点） */
function cer(ref: string, hyp: string): number {
  const a = [...ref.replace(/[\s，。！？、,.!?]/g, '')]
  const b = [...hyp.replace(/[\s，。！？、,.!?]/g, '')]
  if (!a.length) return b.length ? 1 : 0
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length][b.length] / a.length
}

/** 归一化：忽略大小写、空格与横杠 —— ASR 常把 A-100 认成 A100 */
function norm(s: string): string {
  return s.replace(/[\s\-_.]/g, '').toLowerCase()
}

function loadEntities(): string[] {
  const p = join(ASR_DIR, 'hotwords.txt')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function wavOf(s: Sample): string | null {
  // 真人优先：合成语音的 CER 偏乐观，同一条 id 只要有真人录音就用它
  const candidates = [
    s.wav,
    join(REAL_DIR, `${s.id}.wav`),
    join(WAV_DIR, `${s.id}.wav`),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : join(ROOT, c)
    if (existsSync(p)) return p
  }
  return null
}

function runSherpa(wav: string): string | null {
  const cmd = process.env.SHERPA_ASR_CMD
  if (!cmd) return null
  // 例：SHERPA_ASR_CMD="npx tsx scripts/asr-transcribe.ts"
  const r = spawnSync(cmd, [wav], { encoding: 'utf-8', shell: true, timeout: 180_000 })
  if (r.status !== 0) {
    console.warn('sherpa failed', String(r.stderr ?? '').slice(0, 200))
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
  const entities = loadEntities()

  console.log(
    `样本 ${samples.length} · 权重 ${hasModel ? '有' : '无'} · CLI ${hasCmd ? '有' : '无'} · 热词 ${entities.length}`
  )

  if (!hasModel || !hasCmd) {
    console.log(`
⚠️  CER 真实推理未跑（缺权重或 SHERPA_ASR_CMD）。
   1. 权重：见 app/models/OFFLINE_BUNDLE.md（已有 model.int8.onnx）
   2. 运行时：npm i（已含 sherpa-onnx-node）
   3. 设置：set SHERPA_ASR_CMD=npx tsx scripts/asr-transcribe.ts
   4. 音频：npm run asr:wavs（缺真人录音时用 SAPI 合成）
`)
    writeFileSync(
      join(RESULTS, 'asr-cer.md'),
      `# ASR CER\n\n状态：脚手架就位，**待权重 / 待 SHERPA_ASR_CMD**。\n热词：\`models/asr/hotwords.txt\`\n`,
      'utf-8'
    )
    return
  }

  const rows: { id: string; cat: string; ref: string; hyp: string; cer: number }[] = []
  let entTotal = 0
  let entHit = 0

  for (const s of samples) {
    const wav = wavOf(s)
    if (!wav) {
      console.log(`skip ${s.id}（无 wav）`)
      continue
    }
    const hyp = runSherpa(wav) ?? ''
    const c = cer(s.text, hyp)
    rows.push({ id: s.id, cat: s.category ?? '-', ref: s.text, hyp, cer: c })

    // 专有名词命中：黄金文本里出现的热词，识别结果里还在不在
    const refN = norm(s.text)
    const hypN = norm(hyp)
    for (const e of entities) {
      if (!refN.includes(norm(e))) continue
      entTotal++
      if (hypN.includes(norm(e))) entHit++
    }

    console.log(`${s.id} CER=${(c * 100).toFixed(1)}%  hyp=${hyp}`)
  }

  const avg = rows.length ? rows.reduce((a, r) => a + r.cer, 0) / rows.length : null
  const exact = rows.filter((r) => r.cer === 0).length
  const byCat = new Map<string, { n: number; sum: number }>()
  for (const r of rows) {
    const cur = byCat.get(r.cat) ?? { n: 0, sum: 0 }
    cur.n++
    cur.sum += r.cer
    byCat.set(r.cat, cur)
  }

  const md = `# ASR CER

生成：${new Date().toISOString()}
引擎：sherpa-onnx + SenseVoice int8（本地，离线）
音频：${'**SAPI 合成语音**（无真人录音）—— 发音标准、无噪声，CER **偏乐观**'}
样本：${rows.length} 条

| 指标 | 值 |
|---|---|
| 平均 CER | ${avg == null ? '—' : (avg * 100).toFixed(2) + '%'} |
| 完全命中（CER=0） | ${exact}/${rows.length} |
| 专有名词命中率 | ${entTotal ? entHit + '/' + entTotal + ' = ' + ((entHit / entTotal) * 100).toFixed(1) + '%' : '—'} |

> 合成语音只证明「链路通 / 中文与专有名词认得出来」，
> 真人口音下的表现必须另录真人音频再测（ SenseVoice 热词基础准确率 50.17% 是官方数字 ）。

## 分类

| 分类 | CER | 条数 |
|---|---|---|
${[...byCat.entries()]
  .map(([k, v]) => `| ${k} | ${((v.sum / v.n) * 100).toFixed(1)}% | ${v.n} |`)
  .join('\n')}

## 明细

| id | 分类 | CER | ref | hyp |
|---|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.cat} | ${(r.cer * 100).toFixed(1)}% | ${r.ref} | ${r.hyp} |`).join('\n')}
`
  writeFileSync(join(RESULTS, 'asr-cer.md'), md, 'utf-8')
  console.log(
    `\n平均 CER ${avg == null ? '—' : (avg * 100).toFixed(2) + '%'} · 完全命中 ${exact}/${rows.length} · 专有名词 ${entHit}/${entTotal}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
