#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
USER_NAME="${BETMAN_USERNAME:-betman}"
USER_PASS="${BETMAN_PASSWORD:-change-me-now}"
COOKIE_JAR="$(mktemp)"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
QUEUE_PATH="$ROOT_DIR/frontend/data/ai_bet_queue.json"
WATCH_LOG_PATH="$ROOT_DIR/frontend/data/autobet_watch_log.json"
SETTINGS_PATH="$ROOT_DIR/frontend/data/autobet_settings.json"

trap 'rm -f "$COOKIE_JAR"' EXIT

json_len(){
  python - "$1" <<'PY'
import json,sys
p=sys.argv[1]
try:
  d=json.load(open(p))
  print(len(d) if isinstance(d,list) else 0)
except Exception:
  print(0)
PY
}

force_due(){
  python - "$1" <<'PY'
import json,sys,time
p=sys.argv[1]
now=int(time.time()*1000)
try:
  rows=json.load(open(p))
except Exception:
  rows=[]
if isinstance(rows,list):
  for r in rows:
    if isinstance(r,dict):
      r['placeAfterMs']=now-1
json.dump(rows,open(p,'w'),indent=2)
print(len(rows) if isinstance(rows,list) else 0)
PY
}

echo "[e2e] login"
curl -sS -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login" \
  -H 'content-type: application/json' \
  --data "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" >/tmp/autobet_login.json

grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/autobet_login.json || {
  echo "[e2e] FAIL: login failed (check BETMAN_USERNAME/BETMAN_PASSWORD)"
  cat /tmp/autobet_login.json
  exit 1
}

echo "[e2e] save watch settings"
curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/autobet-settings" \
  -H 'content-type: application/json' \
  --data '{"enabled":false,"mode":"watch","platform":"TAB","username":"demo","password":"secret","minSignalPct":40,"minRouteConfidence":40}' >/tmp/autobet_save_watch.json

echo "[e2e] queue watch bet"
curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/place-ai-bets" \
  -H 'content-type: application/json' \
  --data '{"bets":[{"meeting":"SmokeMeeting","race":"1","selection":"Smoke Runner","stake":1,"type":"Win","odds":"3.2","eta":"upcoming","signalPct":80,"routeConfidence":80,"executionRoute":"TAB_FIXED"}]}' >/tmp/autobet_queue_watch.json

echo "[e2e] force queue due + run executor (watch mode)"
force_due "$QUEUE_PATH" >/tmp/autobet_force_due_watch.log
node "$ROOT_DIR/scripts/ai_bet_executor.js" >/tmp/autobet_exec_watch.log 2>&1 || true

grep -q "watch mode logged" /tmp/autobet_exec_watch.log

echo "[e2e] save bet settings"
curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/autobet-settings" \
  -H 'content-type: application/json' \
  --data '{"enabled":true,"mode":"bet","platform":"TAB","username":"demo","password":"secret","minSignalPct":0,"minRouteConfidence":0}' >/tmp/autobet_save_bet.json

echo "[e2e] queue bet-mode order"
curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/place-ai-bets" \
  -H 'content-type: application/json' \
  --data '{"bets":[{"meeting":"SmokeMeeting","race":"2","selection":"Smoke Runner 2","stake":1,"type":"Win","odds":"2.8","eta":"upcoming","signalPct":95,"routeConfidence":95,"executionRoute":"TAB_FIXED"}]}' >/tmp/autobet_queue_bet.json

echo "[e2e] force queue due + run executor (bet mode)"
force_due "$QUEUE_PATH" >/tmp/autobet_force_due_bet.log
node "$ROOT_DIR/scripts/ai_bet_executor.js" >/tmp/autobet_exec_bet.log 2>&1 || true

echo "[e2e] validate artifacts"
QUEUE_LEFT="$(json_len "$QUEUE_PATH")"
WATCH_ROWS="$(json_len "$WATCH_LOG_PATH")"
if [[ "$QUEUE_LEFT" != "0" ]]; then
  echo "[e2e] FAIL: queue not drained ($QUEUE_LEFT)"
  exit 1
fi
if [[ "$WATCH_ROWS" -lt 1 ]]; then
  echo "[e2e] FAIL: watch log empty"
  exit 1
fi

grep -q '"mode": "bet"' "$SETTINGS_PATH"

echo "[e2e] PASS"
echo "[e2e] queue_drained=$QUEUE_LEFT watch_rows=$WATCH_ROWS"
