#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

POLL_SECONDS="${POLL_SECONDS:-60}"
PROFILE_REFRESH_MIN="${PROFILE_REFRESH_MIN:-30}"

last_profile=0

while true; do
  now="$(date +%s)"
  elapsed_min=$(( (now - last_profile) / 60 ))
  if [[ "$last_profile" -eq 0 || "$elapsed_min" -ge "$PROFILE_REFRESH_MIN" ]]; then
    echo "[jobs_runner] refreshing meeting profiles"
    node scripts/meeting_profile.js --date=today --country=AUS || true
    node scripts/meeting_profile.js --date=today --country=NZ --loveracing=true || true
    echo "[jobs_runner] running Loveracing enrichment"
    python3 scripts/loveracing_enrich.py || true
    last_profile="$now"
  fi

  echo "[jobs_runner] poll + status + cache"
  node scripts/racing_poller.js --countries=NZ,AUS,HK --status= --meetings= --long_odds=12 --recent_window=3 --recent_top3=2 --standout_prob=0.35 --standout_ratio=1.8 --split_top1=0.6 --ew_win_min=10 --ew_place_min=3 || true
  node scripts/status_writer.js || true
  node scripts/race_cache_writer.js || true
  python3 scripts/success_tracker.py || true

  sleep "$POLL_SECONDS"
done
