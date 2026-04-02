#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env in $ROOT_DIR" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
PID_FILE="$ROOT_DIR/.betman.pid"
POLLER_PID_FILE="$ROOT_DIR/.betman_poller.pid"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${EXISTING_PID}" ]] && ps -p "$EXISTING_PID" > /dev/null 2>&1; then
    echo "BETMAN already running (PID $EXISTING_PID)"
  else
    : > "$PID_FILE"
  fi
fi

if [[ -f "$POLLER_PID_FILE" ]]; then
  EXISTING_POLLER_PID="$(cat "$POLLER_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${EXISTING_POLLER_PID}" ]] && ps -p "$EXISTING_POLLER_PID" > /dev/null 2>&1; then
    echo "BETMAN poller already running (PID $EXISTING_POLLER_PID)"
  else
    : > "$POLLER_PID_FILE"
  fi
fi

STARTED_ANY=0

if [[ ! -s "$PID_FILE" ]]; then
  nohup node scripts/frontend_server.js >> "$LOG_DIR/frontend_server.log" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  echo "BETMAN started (PID $NEW_PID)"
  STARTED_ANY=1
fi

if [[ ! -s "$POLLER_PID_FILE" ]]; then
  nohup ./scripts/adaptive_poller_loop.sh >> "$LOG_DIR/adaptive_poller_loop.log" 2>&1 &
  NEW_POLLER_PID=$!
  echo "$NEW_POLLER_PID" > "$POLLER_PID_FILE"
  echo "BETMAN poller started (PID $NEW_POLLER_PID)"
  STARTED_ANY=1
fi

if [[ "$STARTED_ANY" -eq 0 ]]; then
  echo "BETMAN and poller already running"
fi

echo "Note: start_betman.sh uses nohup + PID files only; it is not a crash-restart supervisor."
echo "For real crash/login restart on macOS, use: ./scripts/install_launchd_services.sh install"
