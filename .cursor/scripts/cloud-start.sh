#!/usr/bin/env bash
# Per-boot: sync secrets + ensure DB exists (fast, idempotent)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/apps/agent-erp"

if [[ ! -f "$APP/.env" ]]; then
  cp "$APP/.env.example" "$APP/.env"
fi

npx tsx "$APP/scripts/sync-cloud-secrets.ts" 2>/dev/null || true

cd "$APP"
npx tsx -e "import './scripts/bootstrap-env.ts'" 2>/dev/null || true
npx prisma generate --schema=prisma/schema.prisma
npx prisma db push --skip-generate --schema=prisma/schema.prisma

echo "[cloud-start] ready"
