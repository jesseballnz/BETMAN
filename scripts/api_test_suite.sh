#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p memory

echo "[1/2] Public API smoke checks..."
node scripts/api_smoke_public.js | tee memory/api-smoke-public.json

echo "[2/2] Authenticated TAB balance API capture..."
set +e
node scripts/api_capture_balance_calls.js | tee memory/api-balance-capture.json
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  echo "API suite PASS"
  exit 0
fi

echo "API suite PARTIAL: public checks passed, authenticated balance capture had no successful balance response"
exit "$rc"
