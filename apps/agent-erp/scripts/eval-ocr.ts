/**
 * OCR 微信订单截图评测（旁车 .ocr.txt，不依赖真实 OCR 引擎）
 *
 *   npx tsx scripts/eval-ocr.ts
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'
const SAMPLES = join(__dirname, '..', 'eval', 'ocr-samples')

type Case = {
  id: string
  file: string
  expectUtterance: string
  expectVerb: string
  expectCustomer?: string
}

const lines = readFileSync(join(SAMPLES, 'manifest.jsonl'), 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
const cases: Case[] = lines.map((l) => JSON.parse(l))

let pass = 0
for (const c of cases) {
  const text = readFileSync(join(SAMPLES, c.file.replace(/\.png$/, '.ocr.txt')), 'utf-8')
  const r = await fetch(`${BASE}/api/ocr/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then((x) => x.json())

  const verbOk = r.interpret?.verb === c.expectVerb
  const utterOk = r.utterance === c.expectUtterance
  const ok = r.ok && verbOk && utterOk
  if (ok) pass++
  console.log(
    `${ok ? '✓' : '✗'} ${c.id} verb=${r.interpret?.verb ?? '-'} utter=${r.utterance ?? '-'}` +
      (!ok ? ` (期望 ${c.expectVerb} / ${c.expectUtterance})` : '')
  )
}

console.log(`\nOCR 夹具：${pass}/${cases.length} 通过`)
process.exit(pass === cases.length ? 0 : 1)
