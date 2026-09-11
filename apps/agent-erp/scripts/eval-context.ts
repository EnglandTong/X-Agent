/**
 * G3 上下文夹具（OCR 焦点 + 「就按上一张图」+ 摘要）
 *
 *   npx tsx scripts/eval-context.ts
 *   BASE_URL=http://127.0.0.1:3001 npx tsx scripts/eval-context.ts
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'
const SESSION = `eval-g3-${Date.now()}`
const OCR_TEXT = readFileSync(
  join(__dirname, '..', 'eval', 'ocr-samples', 'sample-01.ocr.txt'),
  'utf-8'
)

let pass = 0

// 1) OCR 建焦点（张三公司 → 张三）
const ocr = await fetch(`${BASE}/api/ocr/text`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: OCR_TEXT, sessionId: SESSION }),
}).then((r) => r.json())

const ocrOk =
  ocr.ok &&
  ocr.interpret?.verb === 'order.create' &&
  ocr.correlationId?.startsWith('CUS:')
if (ocrOk) pass++
console.log(
  `${ocrOk ? '✓' : '✗'} C1 OCR 焦点 correlationId=${ocr.correlationId ?? '-'}`
)

// 2) 「就按上一张图」沿用客户
const ref = await fetch(`${BASE}/api/interpret`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    utterance: '就按上一张图来10个A-100',
    sessionId: SESSION,
    modality: 'text',
  }),
}).then((r) => r.json())

const cust = ref.slots?.find((s: { slot: string }) => s.slot === 'customer')
const refOk =
  ref.verb === 'order.create' &&
  ref.contextApplied?.customer &&
  cust?.value &&
  ref.contextSummary?.lines?.length >= 1
if (refOk) pass++
console.log(
  `${refOk ? '✓' : '✗'} C2 上下文引用 customer=${cust?.label ?? '-'} applied=${ref.contextApplied?.customer ?? '-'}`
)

// 3) 摘要含信用
const creditLine = ref.contextSummary?.lines?.find((l: { kind: string }) => l.kind === 'credit')
const sumOk = !!creditLine?.text?.includes('信用')
if (sumOk) pass++
console.log(`${sumOk ? '✓' : '✗'} C3 摘要含信用：${creditLine?.text?.slice(0, 40) ?? '-'}…`)

console.log(`\nG3 夹具：${pass}/3 通过`)
process.exit(pass === 3 ? 0 : 1)
