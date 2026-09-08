/**
 * sherpa-onnx 离线转写 CLI —— 给 `asr-cer.ts` 的 SHERPA_ASR_CMD 用
 *
 *   npx tsx scripts/asr-transcribe.ts <wav> [wav...]
 *
 * 每个文件输出一行转写文本（顺序对应输入），不掺任何额外输出 ——
 * 否则 CER 会拿日志当识别结果。
 *
 * 用法（本项目）：
 *   set SHERPA_ASR_CMD=npx tsx scripts/asr-transcribe.ts
 *   npm run asr:cer
 *
 * 关 ITN（`useInverseTextNormalization: 0`）：黄金文本写的是「五十」而不是「50」，
 * 开了 ITN 会把数字规整化，反而制造假错例。
 */

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const sherpa = require_('sherpa-onnx-node')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODEL = join(ROOT, 'models/asr/sensevoice/model.int8.onnx')
const TOKENS = join(ROOT, 'models/asr/sensevoice/tokens.txt')

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：npx tsx scripts/asr-transcribe.ts <wav> [wav...]')
  process.exit(1)
}
if (!existsSync(MODEL) || !existsSync(TOKENS)) {
  console.error(`缺权重或词表：${MODEL} / ${TOKENS}`)
  process.exit(2)
}

const recognizer = new sherpa.OfflineRecognizer({
  modelConfig: {
    senseVoice: { model: MODEL, language: 'zh', useInverseTextNormalization: 0 },
    tokens: TOKENS,
    numThreads: 4,
    debug: 0,
  },
})

for (const wav of files) {
  if (!existsSync(wav)) {
    console.log('')
    continue
  }
  const wave = sherpa.readWave(wav)
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  console.log(String(result.text ?? '').trim())
}
