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
 * 开了 ITN 会把数字规整化，反而制造假错例。—— 该配置现在由 `src/server/asr.ts`
 * 的 `buildRecognizerConfig()` 统一持有，本文件不再自己构造 recognizer。
 */

import { existsSync } from 'node:fs'
import { transcribeWavFile, MODEL_PATH, TOKENS_PATH } from '../src/server/asr'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：npx tsx scripts/asr-transcribe.ts <wav> [wav...]')
  process.exit(1)
}
if (!existsSync(MODEL_PATH) || !existsSync(TOKENS_PATH)) {
  console.error(`缺权重或词表：${MODEL_PATH} / ${TOKENS_PATH}`)
  process.exit(2)
}

for (const wav of files) {
  if (!existsSync(wav)) {
    console.log('')
    continue
  }
  // asr.ts 的日志走 stderr，所以 stdout 依然只有一行识别结果
  console.log((await transcribeWavFile(wav)).text)
}
