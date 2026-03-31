#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
API_KEY="${2:-}"
SESSION_TOKEN="${3:-}"

if [[ -z "$API_KEY" ]]; then
  echo "Usage: $0 <base-url> <api-key> [session-token]" >&2
  exit 1
fi

endpoints=(
  "/api/v1/me"
  "/api/v1/status"
  "/api/v1/suggested-bets"
  "/api/v1/market-movers"
  "/api/v1/interesting-runners"
  "/api/v1/alerts-feed"
  "/api/v1/alerts-history"
  "/api/v1/learnings-report"
)

echo "== API KEY TEST =="
for ep in "${endpoints[@]}"; do
  code=$(curl -sS -o /tmp/betman_mobile_auth.out -w "%{http_code}" -H "X-API-Key: ${API_KEY}" "${BASE_URL}${ep}" || true)
  echo "${ep} -> ${code}"
  head -c 220 /tmp/betman_mobile_auth.out; echo; echo '---'
done

if [[ -n "$SESSION_TOKEN" ]]; then
  echo "== SESSION TOKEN TEST =="
  for ep in "${endpoints[@]}"; do
    code=$(curl -sS -o /tmp/betman_mobile_auth.out -w "%{http_code}" -H "Authorization: Bearer ${SESSION_TOKEN}" "${BASE_URL}${ep}" || true)
    echo "${ep} -> ${code}"
    head -c 220 /tmp/betman_mobile_auth.out; echo; echo '---'
  done
fi
