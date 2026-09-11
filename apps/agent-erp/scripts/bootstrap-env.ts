/**
 * Load apps/agent-erp/.env then .env.local into process.env (only unset keys).
 * Import as the first line of CLI scripts (seed, setup helpers).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function applyFile(name: string) {
  const p = join(ROOT, name)
  if (!existsSync(p)) return
  for (const [k, v] of Object.entries(parseEnv(readFileSync(p, 'utf-8')))) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v
    }
  }
}

applyFile('.env')
applyFile('.env.local')
