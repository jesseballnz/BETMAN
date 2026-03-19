#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/meeting_profile.js --date=today --country=AUS || true
node scripts/meeting_profile.js --date=today --country=NZ --loveracing=true || true
node scripts/racing_poller.js --countries=NZ,AUS,HK --status= --meetings= --long_odds=12 --recent_window=3 --recent_top3=2 --standout_prob=0.35 --standout_ratio=1.8 --split_top1=0.6 --ew_win_min=10 --ew_place_min=3 || true
node scripts/status_writer.js || true
node scripts/race_cache_writer.js || true

echo "[jobs_once] completed $(date -u +%Y-%m-%dT%H:%M:%SZ)"
