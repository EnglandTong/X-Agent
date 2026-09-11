/**
 * Download SenseVoice int8 weights if missing (~229MB onnx).
 * Idempotent — safe for cloud install and local setup.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'models/asr/sensevoice')
const ONNX = join(TARGET, 'model.int8.onnx')
const MIN_BYTES = 200 * 1024 * 1024

const ASSET_SUBSTR = 'sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'

function onnxReady(): boolean {
  return existsSync(ONNX) && statSync(ONNX).size >= MIN_BYTES
}

async function resolveDownloadUrl(): Promise<string> {
  const api =
    'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models'
  const res = await fetch(api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'x-agent-setup' },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const release = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] }
  const asset = release.assets?.find((a) => a.name.includes(ASSET_SUBSTR) && a.name.endsWith('.tar.bz2'))
  if (!asset) throw new Error(`asset not found: ${ASSET_SUBSTR}`)
  return asset.browser_download_url
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'x-agent-setup' } })
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`)
  await pipeline(res.body as NodeJS.ReadableStream, createWriteStream(dest))
}

function extractTarBz2(archive: string, outDir: string) {
  mkdirSync(outDir, { recursive: true })
  execSync(`tar -xjf "${archive}" -C "${outDir}"`, { stdio: 'inherit' })
}

function copyOnnxAndTokens(extractRoot: string) {
  mkdirSync(TARGET, { recursive: true })
  const walk = (dir: string): string[] => {
    const hits: string[] = []
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) hits.push(...walk(p))
      else hits.push(p)
    }
    return hits
  }
  const files = walk(extractRoot)
  const onnx = files.find((f) => f.endsWith('model.int8.onnx'))
  const tokens = files.find((f) => f.endsWith('tokens.txt'))
  if (!onnx || !tokens) throw new Error('extracted archive missing model.int8.onnx or tokens.txt')
  execSync(`cp "${onnx}" "${join(TARGET, 'model.int8.onnx')}"`)
  execSync(`cp "${tokens}" "${join(TARGET, 'tokens.txt')}"`)
  const license = files.find((f) => /LICENSE/i.test(f))
  if (license) execSync(`cp "${license}" "${join(TARGET, 'LICENSE')}"`)
}

async function main() {
  if (onnxReady()) {
    const mb = (statSync(ONNX).size / (1024 * 1024)).toFixed(1)
    console.log(`download-asr-weights: already present (${mb} MB)`)
    return
  }

  console.log('download-asr-weights: fetching SenseVoice int8 (~155MB archive)...')
  mkdirSync(TARGET, { recursive: true })
  const url = await resolveDownloadUrl()
  const tmp = join(tmpdir(), `sensevoice-${randomBytes(4).toString('hex')}.tar.bz2`)
  const extractDir = join(tmpdir(), `sensevoice-extract-${randomBytes(4).toString('hex')}`)

  try {
    await download(url, tmp)
    extractTarBz2(tmp, extractDir)
    copyOnnxAndTokens(extractDir)
  } finally {
    try {
      execSync(`rm -rf "${tmp}" "${extractDir}"`)
    } catch {
      /* ignore */
    }
  }

  if (!onnxReady()) throw new Error('model.int8.onnx still missing after extract')
  const mb = (statSync(ONNX).size / (1024 * 1024)).toFixed(1)
  console.log(`download-asr-weights: OK (${mb} MB)`)
}

main().catch((e) => {
  console.error('download-asr-weights:', e instanceof Error ? e.message : e)
  console.error('  ASR local engine will stay unavailable; browser Web Speech still works.')
  process.exit(0) // non-fatal for cloud install
})
