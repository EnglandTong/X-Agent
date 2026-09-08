/**
 * 「耳」端到端等价验证：`npm run verify:asr`
 *
 * 要证明的只有一件事 —— **在用的耳朵 = 被测的耳朵**：
 *   画布点麦克风走的 `/api/asr`，与产出那份 CER 报告的离线转写，
 *   对同一批 wav 必须给出**逐字相同**的文本。相同 ⇒ 报告里的 34.02% 就是线上数字。
 *
 * 为什么不在这儿重算 CER：hyp 逐字相同已经蕴含 CER 相同，再抄一份 cer() 只会造出
 * 第二份「碰巧一致」的实现 —— 那正是本轮要消灭的东西。
 *
 * 前置：服务已起（`npm run serve`，ASR_ENGINE=local）、`npm run asr:cer` 跑过（有报告）
 * 缺前置时：打印指引并 exit 0 —— eval/ 与模型都在 .gitignore，不能做成 CI 硬门。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WAV_DIR = join(ROOT, 'eval/asr-wavs')
const REAL_DIR = join(ROOT, 'eval/asr-wavs-real')
const REPORT = join(ROOT, 'eval/results/asr-cer.md')
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')

interface Row {
  id: string
  cat: string
  cerPct: string
  ref: string
  hyp: string
}

/** 认报告明细表：| id | 分类 | CER | ref | hyp | */
function parseReport(md: string): Row[] {
  const rows: Row[] = []
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length !== 5) continue
    const [id, cat, cerPct, ref, hyp] = cells
    if (id === 'id' || /^-+$/.test(id)) continue
    rows.push({ id, cat, cerPct, ref, hyp })
  }
  return rows
}

function guidance(why: string): never {
  console.log(`\n⏭️  跳过等价验证：${why}
   1. 起服务：ASR_ENGINE=local npm run serve   （默认引擎是 browser，/api/asr 会回 skipped）
   2. 造音频：npm run asr:wavs                 （缺真人录音时用 SAPI 合成）
   3. 跑评测：set SHERPA_ASR_CMD=npx tsx scripts/asr-transcribe.ts && npm run asr:cer`)
  process.exit(0)
}

async function postWav(bytes: Buffer): Promise<{ text: string; decodeMs?: number; audioMs?: number; ok: boolean; reason?: string }> {
  const r = await fetch(`${BASE}/api/asr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes) as unknown as BodyInit,
  })
  const j: any = await r.json().catch(() => ({}))
  return { text: String(j?.text ?? ''), decodeMs: j?.decodeMs, audioMs: j?.audioMs, ok: !!j?.ok, reason: j?.reason ?? j?.skipped }
}

function pct(vals: number[], q: number): number {
  if (!vals.length) return 0
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))]
}

async function main() {
  if (!existsSync(REPORT)) guidance(`没有报告 ${REPORT.replace(/\\/g, '/')}`)
  if (!existsSync(WAV_DIR) || !readdirSync(WAV_DIR).some((f) => f.endsWith('.wav')))
    guidance(`没有合成音频 ${WAV_DIR.replace(/\\/g, '/')}`)

  const md = readFileSync(REPORT, 'utf-8')
  const rows = parseReport(md)
  if (!rows.length) guidance('报告里没有明细行（跑一次 npm run asr:cer）')

  // 报告里是表格单元格「| 平均 CER | 34.02% |」，指标名与数字之间隔着「 | 」
  const reportedAvg = md.match(/平均 CER[^0-9]*([\d.]+)%/)?.[1] ?? '?'
  const reportedExact = md.match(/完全命中[^0-9]*(\d+)\/(\d+)/)
  const reportedEnt = md.match(/专有名词命中率[^0-9]*(\d+)\/(\d+)/)

  let gate
  try {
    gate = await fetch(`${BASE}/api/asr/status`, { signal: AbortSignal.timeout(3000) })
  } catch {
    guidance(`服务没在 ${BASE} 上跑`)
  }
  const st: any = await gate.json()
  if (st.state !== 'ready') guidance(`模型状态是 ${st.state}（需要 ready；引擎设成 local 后重启服务或点自检）`)

  console.log(`\n🔊 「耳」等价验证 · ${rows.length} 条 · 报告 CER ${reportedAvg}% · ${BASE}`)
  console.log(`   模型 ${st.state} · 加载 ${st.loadMs ?? '?'}ms · 常驻 ${st.rssMiB ?? '?'}MiB\n`)

  const decodeMs: number[] = []
  const rtf: number[] = []
  const misses: string[] = []
  let matched = 0

  for (const r of rows) {
    const wavPath = join(WAV_DIR, `${r.id}.wav`)
    if (!existsSync(wavPath)) {
      misses.push(`${r.id}  wav 缺失`)
      continue
    }
    const j = await postWav(readFileSync(wavPath))
    if (!j.ok) {
      misses.push(`${r.id}  →  ${j.reason ?? '失败'}`)
      continue
    }
    if (j.text === r.hyp) {
      matched++
    } else {
      misses.push(`${r.id}  报告=「${r.hyp}」  HTTP=「${j.text}」`)
    }
    if (j.decodeMs && j.audioMs) {
      decodeMs.push(j.decodeMs)
      rtf.push(j.decodeMs / j.audioMs)
    }
  }

  // 真人 16k 语料（画布「存为语料」产出）：有就一起打，它才是真数字
  const realWavs = existsSync(REAL_DIR) ? readdirSync(REAL_DIR).filter((f) => f.endsWith('.wav')) : []

  console.log(`A. 逐字等价（HTTP /api/asr vs 报告 hyp）：${matched}/${rows.length}`)
  for (const m of misses) console.log(`   ✗ ${m}`)
  if (!misses.length) console.log('   ✓ 全部一致 ⇒ 线上链路不动字节 ⇒ 报告 CER 即实走 CER')
  console.log(`   推论：hyp 逐字相同 ⇒ 平均 CER 仍是 ${reportedAvg}%（故此处不重算，避免第二份实现）`)

  if (decodeMs.length) {
    console.log(
      `\nD. 性能：decode ms p50=${pct(decodeMs, 0.5)} p90=${pct(decodeMs, 0.9)} max=${Math.max(...decodeMs)}
      RTF  p50=${pct(rtf, 0.5).toFixed(3)} p90=${pct(rtf, 0.9).toFixed(3)} max=${Math.max(...rtf).toFixed(3)}（<1 即比人说得快）`
    )
  }

  if (!realWavs.length) {
    console.log(
      `\nC. 真人语料：0 条（${REAL_DIR.replace(/\\/g, '/')} 不存在）\n   现在这 ${rows.length} 条全是 SAPI 合成 → 34% 偏乐观。\n   画布切本地引擎录一句 → 点「存为语料」→ 再跑本脚本与 npm run asr:cer，那才是真数字。`
    )
  } else {
    console.log(`\nC. 真人语料 ${realWavs.length} 条（16k 采集，走同一路由）`)
    for (const f of realWavs) {
      const j = await postWav(readFileSync(join(REAL_DIR, f)))
      console.log(`   ${f.replace(/\.wav$/, '').padEnd(18)} ${j.ok ? j.text || '（空）' : `失败：${j.reason}`}`)
    }
    console.log('   这些文件会被 npm run asr:cer 自动优先采用（同名覆盖合成音频）')
  }

  const ok = matched === rows.length
  const ent = reportedEnt ? ` · 专有名词 ${reportedEnt[1]}/${reportedEnt[2]}` : ''
  console.log(
    `\n${ok ? '✅' : '⚠️'} 等价 ${matched}/${rows.length}${reportedExact ? ` · 报告完全命中 ${reportedExact[1]}/${reportedExact[2]}` : ''}${ent}`
  )
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('verify:asr 失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
