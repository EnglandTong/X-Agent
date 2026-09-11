/**
 * 造 ASR 评测音频：`npm run asr:wavs`
 *
 * 真人录音缺位时，用系统自己的嘴（SAPI）把 39 条真口吻念一遍，
 * 落 eval/asr-wavs/<id>.wav，供 `npm run asr:cer` 跑真实识别。
 *
 * ⚠️ 这是**合成语音**：发音标准、无口音、无环境噪声 → CER 会偏乐观。
 *    它回答的是「链路通不通 / 中文与专有名词认不认得」，不是「真人口音下准不准」。
 */

import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { synthesizeWav } from '../src/server/speak'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SAMPLES = join(ROOT, 'eval/asr-utterances.jsonl')
const OUT_DIR = join(ROOT, 'eval/asr-wavs')

interface Sample {
  id: string
  text: string
  category?: string
}

const samples: Sample[] = readFileSync(SAMPLES, 'utf-8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Sample)

mkdirSync(OUT_DIR, { recursive: true })

let made = 0
let skipped = 0
let failed = 0

for (const s of samples) {
  const out = join(OUT_DIR, `${s.id}.wav`)
  if (existsSync(out) && statSync(out).size > 1000) {
    skipped++
    continue
  }
  const ok = await synthesizeWav(s.text, out)
  if (ok && existsSync(out) && statSync(out).size > 1000) {
    made++
    console.log(`✓ ${s.id}  ${s.text}`)
  } else {
    failed++
    console.log(`✗ ${s.id}  合成失败：${s.text}`)
  }
}

console.log(`\n造音频：新建 ${made} · 已存在 ${skipped} · 失败 ${failed} · 目录 ${OUT_DIR}`)
if (failed) process.exit(1)
