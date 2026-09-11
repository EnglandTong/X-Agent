#!/usr/bin/env bash
# X-Agent Cloud Agent install — idempotent
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/apps/agent-erp"

echo "[cloud-install] repo=$ROOT"
cd "$ROOT"
npm install

if [[ ! -f "$APP/.env" ]]; then
  cp "$APP/.env.example" "$APP/.env"
  echo "[cloud-install] created $APP/.env from example"
fi

npx tsx "$APP/scripts/sync-cloud-secrets.ts"
npx tsx "$APP/scripts/download-asr-weights.ts"

cd "$APP"
npm run setup
npm run build

echo "[cloud-install] done"
