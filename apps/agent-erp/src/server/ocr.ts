/**
 * 眼（OCR）—— 图 → Observation.text
 *
 * 优先 tesseract.js（chi_sim）；评测/无权重时读同目录 .ocr.txt 旁车文件。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Observation } from '@x-agent/core/observation'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')

export interface OcrResult {
  ok: boolean
  text: string
  confidence: number
  engine: 'tesseract' | 'sidecar' | 'none'
  observation: Observation
  reason?: string
}

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
let workerPromise: Promise<OcrWorker> | null = null

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      return createWorker('chi_sim')
    })()
  }
  return workerPromise
}

/** 旁车文本：eval/ocr-samples/foo.png → foo.ocr.txt */
export function sidecarPathFor(imagePath: string): string {
  const dir = dirname(imagePath)
  const base = basename(imagePath).replace(/\.[^.]+$/, '')
  return join(dir, `${base}.ocr.txt`)
}

export function readSidecarText(imagePath: string): string | null {
  const p = sidecarPathFor(imagePath)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8').trim()
}

export async function recognizeImage(
  bytes: Buffer,
  opts: { filename?: string; sidecarDir?: string } = {}
): Promise<OcrResult> {
  const at = new Date().toISOString()
  const emptyObs: Observation = {
    modality: 'image',
    source: 'upload',
    at,
    payload: '',
    confidence: 0,
    recognizer: 'none',
  }

  // 旁车（CI / 脱敏样张）
  if (opts.filename && opts.sidecarDir) {
    const side = readSidecarText(join(opts.sidecarDir, opts.filename))
    if (side) {
      return {
        ok: true,
        text: side,
        confidence: 0.95,
        engine: 'sidecar',
        observation: {
          modality: 'image',
          source: 'upload',
          at,
          payload: side,
          confidence: 0.95,
          recognizer: 'sidecar-fixture',
          raw: opts.filename,
        },
      }
    }
  }

  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(bytes)
    const text = (data.text ?? '').trim()
    return {
      ok: text.length > 0,
      text,
      confidence: data.confidence / 100,
      engine: 'tesseract',
      observation: {
        modality: 'image',
        source: 'upload',
        at,
        payload: text,
        confidence: data.confidence / 100,
        recognizer: 'tesseract-chi_sim',
        raw: opts.filename,
      },
    }
  } catch (e) {
    return {
      ok: false,
      text: '',
      confidence: 0,
      engine: 'none',
      observation: emptyObs,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

export function ocrStatus() {
  return {
    supported: true,
    engine: 'tesseract.js',
    lang: 'chi_sim',
    note: '评测样张可用 .ocr.txt 旁车，无需真实 OCR',
  }
}
