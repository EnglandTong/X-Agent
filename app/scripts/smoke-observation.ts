/**
 * Observation 契约冒烟：`npx tsx scripts/smoke-observation.ts`
 * 纯函数，不启服务。
 */
import {
  textObservation,
  observationText,
  type Observation,
  type SensoryAdapter,
  type ModelAdapter,
} from '../src/core/observation'

let failed = 0
function check(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failed++
}

const o = textObservation('给张三来五十个A-100')
check('textObservation modality=text', o.modality === 'text')
check('textObservation payload 即原话', observationText(o) === '给张三来五十个A-100')
check('recognizer=passthrough', o.recognizer === 'passthrough')

const audioLike: Observation = {
  modality: 'audio',
  source: 'mic-01',
  at: new Date().toISOString(),
  payload: '给张三来五十个 a 杠一百',
  confidence: 0.8,
  recognizer: 'local-sensevoice',
}
check('audio Observation 核心仍只吃 text payload', observationText(audioLike).includes('杠一百'))

const fakeEar: SensoryAdapter = {
  id: 'fake-ear',
  modality: 'audio',
  recognize(input: unknown) {
    return {
      modality: 'audio',
      source: 'test',
      at: new Date().toISOString(),
      payload: String(input),
      recognizer: 'fake-ear',
    }
  },
}
check('SensoryAdapter 可构造', fakeEar.recognize('你好').payload === '你好')

const fakeBrain: ModelAdapter = {
  id: 'fake-rules',
  kind: 'rules',
  async extract(obs) {
    const text = typeof obs === 'string' ? obs : observationText(obs)
    return { verb: 'order.create', confidence: 0.9, slots: { utterance: text } }
  },
}
const r = await fakeBrain.extract(o)
check('ModelAdapter 吃 Observation', r.verb === 'order.create' && r.slots.utterance.includes('张三'))

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
