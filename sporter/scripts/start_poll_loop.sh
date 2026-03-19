#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/memory/poll_loop.log"
ARCHIVE_DIR="$ROOT/memory/log_archive"
PID_FILE="$ROOT/memory/poll_loop.pid"

mkdir -p "$ROOT/memory" "$ARCHIVE_DIR"

# Rotate existing log if present (keep last 5 archives)
if [[ -s "$LOG" ]]; then
  ts=$(date -u +"%Y%m%d-%H%M%S")
  archive="$ARCHIVE_DIR/poll_loop-$ts.log"
  mv "$LOG" "$archive"
  ls -1t "$ARCHIVE_DIR"/poll_loop-*.log 2>/dev/null | tail -n +6 | xargs -r rm -f || true
fi

# Stop existing loop if running
if [[ -f "$PID_FILE" ]]; then
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

nohup node scripts/live_poll_loop.js > "$LOG" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"
echo "Sportr poll loop started (PID $PID), logging to $LOG"
