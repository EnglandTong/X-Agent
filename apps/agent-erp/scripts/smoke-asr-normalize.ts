/**
 * ASR 文本规整冒烟：`npm run smoke:asr-normalize`
 *
 * 纯函数，不启服务、不碰 DB。词典用种子主数据的静态子集。
 * 验收：CER 里 SenseVoice 常见读法能归一；干净口吻不被误伤。
 */

import {
  normalizeAsrText,
  spokenDigitsToArabic,
  spokenVariantsOf,
  type AsrNormalizeDict,
} from '../src/server/asrNormalize'

const DICT: AsrNormalizeDict = {
  products: [{ model: 'A-100' }, { model: 'B-200' }, { model: 'C-300' }],
  customers: [{ code: 'C001' }, { code: 'C002' }, { code: 'C003' }, { code: 'C004' }],
  extras: ['SO-2026-1007'],
}

let failed = 0
function check(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed++
}

function expectNorm(raw: string, want: string) {
  const r = normalizeAsrText(raw, DICT)
  check(`「${raw}」→「${want}」`, r.text === want, r.text === want ? '' : `实际「${r.text}」`)
}

function expectIntact(raw: string) {
  const r = normalizeAsrText(raw, DICT)
  check(`干净口吻不改动：「${raw}」`, r.text === raw && !r.changed, r.changed ? `被改成「${r.text}」` : '')
}

console.log('— spokenDigitsToArabic —')
check('一百 → 100', spokenDigitsToArabic('一百') === '100')
check('一零零 → 100', spokenDigitsToArabic('一零零') === '100')
check('幺零零七 → 1007', spokenDigitsToArabic('幺零零七') === '1007')
check('二零二六 → 2026', spokenDigitsToArabic('二零二六') === '2026')
check('两百 → 200', spokenDigitsToArabic('两百') === '200')

console.log('\n— spokenVariantsOf(A-100) 含关键表面 —')
{
  const vs = spokenVariantsOf('A-100').map((v) => v.replace(/\s+/g, '').toLowerCase())
  check('含 a杠一百', vs.some((v) => v.includes('a') && v.includes('一百')))
  check('含 a一零零', vs.some((v) => v === 'a一零零' || v === 'a杠一零零'))
}

console.log('\n— SenseVoice 风格读法（CER 真例）—')
expectNorm('给张三百五十个 a 杠一百', '给张三百五十个 A-100')
expectNorm('a 杠一百', 'A-100')
expectNorm('a杠一百', 'A-100')
expectNorm('a 一 零 零', 'A-100')
expectNorm('B两百', 'B-200')
expectNorm('B两百来五十个', 'B-200来五十个')
expectNorm('A100 一百个', 'A-100 一百个')
expectNorm('c零零一', 'C001')
expectNorm('s o 杠二零二六杠幺零零七', 'SO-2026-1007')

console.log('\n— 幂等：规范写法再跑一遍不改 —')
expectIntact('给张三来五十个A-100')
expectIntact('查一下华东仓库存')
expectIntact('A-100')
expectIntact('SO-2026-1007')
expectIntact('来一百个A-100')
expectIntact('杠笔多少钱')

console.log('\n— 数量口语不被型号规则误吞 —')
{
  const r = normalizeAsrText('来一百个', DICT)
  check('「来一百个」保持原样', r.text === '来一百个' && !r.changed)
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 条`}`)
process.exit(failed === 0 ? 0 : 1)
