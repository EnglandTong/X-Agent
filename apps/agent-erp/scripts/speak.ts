/**
 * TTS · CLI：npm run say -- 客户张三，一百二十个A-100，请确认
 *
 * 实现在 src/server/speak.ts —— 画布播报与 CLI 共用一套，
 * 免得「命令行能念、画布念不出」这种两份逻辑漂移。
 */

import { speak } from '../src/server/speak'

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('用法：npm run say -- 要说的话')
  process.exit(1)
}

const r = await speak(text)
console.log(
  r.ok ? `[speak] 已播报：${text}` : `[speak] 没出声（${r.reason}），文本如下：\n${text}`
)
