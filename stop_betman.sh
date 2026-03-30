#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PID_FILE="$ROOT_DIR/.betman.pid"
POLLER_PID_FILE="$ROOT_DIR/.betman_poller.pid"

stop_from_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && ps -p "$pid" > /dev/null 2>&1; then
      kill "$pid"
      echo "Sent stop to ${label} (PID $pid)"
    else
      echo "No running ${label} process found for PID file."
    fi
    : > "$pid_file"
  else
    echo "No PID file found for ${label}."
  fi
}

stop_from_pid_file "$PID_FILE" "BETMAN"
stop_from_pid_file "$POLLER_PID_FILE" "BETMAN poller"
