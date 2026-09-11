/**
 * Cloud Agent install: copy LLM_* from process.env into .env.local when present.
 * settings.ts already prefers process.env; this persists keys across serve restarts.
 */
import './bootstrap-env.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_LOCAL = join(ROOT, '.env.local')

const SYNC_KEYS = [
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_TIMEOUT_MS',
  'TTS_ENABLED',
  'ASR_ENGINE',
] as const

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const file = existsSync(ENV_LOCAL) ? parseEnv(readFileSync(ENV_LOCAL, 'utf-8')) : {}
let changed = 0

for (const key of SYNC_KEYS) {
  const v = process.env[key]
  if (v && v.trim()) {
    file[key] = v.trim()
    changed++
  }
}

if (changed === 0) {
  console.log('sync-cloud-secrets: no LLM_* in process.env — skip (rules engine OK)')
  process.exit(0)
}

const body = Object.entries(file)
  .map(([k, v]) => `${k}=${/\s|#|"/.test(v) ? JSON.stringify(v) : v}`)
  .join('\n')

writeFileSync(
  ENV_LOCAL,
  `# AGT-ERP cloud secrets (synced from environment; gitignored)\n${body}\n`,
  'utf-8'
)
console.log(`sync-cloud-secrets: wrote ${changed} key(s) → .env.local`)
