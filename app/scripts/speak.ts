/**
 * TTS · Windows SAPI（决策：S1 用 SAPI，0MB、零依赖）
 *
 *   npm run say -- 客户张三，一百二十个A-100，请确认
 *
 * 文本经 base64 传给 PowerShell，避开引号与中文编码坑。
 * 只在本机（Windows）出声；其它平台打印文本并退出。
 */

import { spawnSync } from 'node:child_process'

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('用法：npm run say -- 要说的话')
  process.exit(1)
}

const b64 = Buffer.from(text, 'utf8').toString('base64')
const script = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.Volume = 100',
  '$s.Rate = 0',
  `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
  '$s.Speak($t)',
].join('; ')

const r = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { stdio: 'inherit' }
)

if (r.status !== 0) {
  // 非 Windows / 缺 SAPI：不报错，只打印 —— 「嘴」缺位不能影响主流程
  console.log(`[speak] SAPI 不可用（status=${r.status}），文本如下：\n${text}`)
  process.exit(0)
}
console.log(`[speak] 已播报：${text}`)
