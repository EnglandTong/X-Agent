/**
 * 真口吻评测 —— 用 ASR 评测集跑 interpret 的动词准确率
 *
 * 为什么需要它：`eval/utterances.jsonl`（50 条）写得太规整，规则档能跑到 96%，
 * 但同一套规则在 `eval/asr-utterances.jsonl`（口语/口误/同音/单位杂乱）下只有 ~78%。
 * 这个脚本就是用来**持续暴露这个差距**的 —— T4 改消解后必须重跑，看有没有变好。
 *
 *   npm run eval:asr                                   # 云端档（默认 3001）
 *   BASE_URL=http://127.0.0.1:3002 npm run eval:asr    # 规则档（先起 rules 实例）
 *   起规则档：set LLM_PROVIDER=rules&& set PORT=3002&& npm run serve
 *
 * 样本字段：id / text / category / expectVerb / note
 *   expectVerb = "none" 表示范围外（如「杠笔多少钱」），只记录实际输出，不计分。
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'

const samples = readFileSync(join(__dirname, '..', 'eval', 'asr-utterances.jsonl'), 'utf-8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l))

let ok = 0
let n = 0
const miss: string[] = []
const byCategory = new Map<string, { ok: number; n: number }>()

for (const s of samples) {
  const r = await fetch(`${BASE}/api/interpret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ utterance: s.text }),
  }).then((x) => x.json())

  const graded = s.expectVerb !== 'none'
  const hit = graded && r.verb === s.expectVerb

  if (graded) {
    n++
    if (hit) ok++
    else miss.push(`${s.id}  ${s.text}  期望=${s.expectVerb} 实际=${r.verb}`)
    const c = byCategory.get(s.category) ?? { ok: 0, n: 0 }
    c.n++
    if (hit) c.ok++
    byCategory.set(s.category, c)
  } else {
    miss.push(`${s.id}  ${s.text}  （范围外，实际=${r.verb}）`)
  }
}

console.log(`\n样本 ${samples.length} 条 · 计分 ${n} 条 · ${BASE}`)
console.log(`动词准确率：${ok}/${n} = ${((ok / n) * 100).toFixed(1)}%`)

console.log('\n—— 分类 ——')
for (const [c, v] of [...byCategory.entries()].sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n)) {
  console.log(`  ${c.padEnd(10)} ${v.ok}/${v.n} = ${((v.ok / v.n) * 100).toFixed(0)}%`)
}

if (miss.length) {
  console.log('\n—— 未命中 / 范围外 ——')
  for (const m of miss) console.log('  ' + m)
}
