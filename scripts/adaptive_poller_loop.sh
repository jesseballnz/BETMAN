#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

while true; do
  stake_json="frontend/data/stake.json"

  stake_per_race=$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('${stake_json}','utf8'));process.stdout.write(String(s.stakePerRace??10));}catch{process.stdout.write('10')}" )
  exotic_stake=$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('${stake_json}','utf8'));process.stdout.write(String(s.exoticStakePerRace??1));}catch{process.stdout.write('1')}" )
  early_window=$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('${stake_json}','utf8'));process.stdout.write(String(s.earlyWindowMin??180));}catch{process.stdout.write('180')}" )
  ai_window=$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('${stake_json}','utf8'));process.stdout.write(String(s.aiWindowMin??10));}catch{process.stdout.write('10')}" )

  node scripts/racing_poller.js \
    --countries=NZ,AUS \
    --status= \
    --meetings= \
    --long_odds=12 \
    --recent_window=3 \
    --recent_top3=2 \
    --stake_per_race="${stake_per_race}" \
    --exotic_stake_per_race="${exotic_stake}" \
    --early_window_min="${early_window}" \
    --ai_window_min="${ai_window}" \
    --standout_prob=0.35 \
    --standout_ratio=1.8 \
    --split_top1=0.6 \
    --ew_win_min=6 \
    --ew_place_min=2

  node scripts/race_cache_writer.js
  node scripts/status_writer.js

  # If next race is very close (<=5m), poll every 60s. Otherwise every 300s.
  sleep_s=$(node -e "const fs=require('fs');const p='memory/racing-poll-state.json';let s=300;try{const st=JSON.parse(fs.readFileSync(p,'utf8'));const now=Date.now();let min=Infinity;for(const r of Object.values(st.races||{})){const raw=r.advertised_start; if(raw==null) continue; let t=Number(raw); if(!Number.isFinite(t)) continue; if(t<1e12) t*=1000; const m=(t-now)/60000; if(m>=0 && m<min) min=m;} if(min<=5) s=60;}catch{} process.stdout.write(String(s));")
  echo "adaptive poller sleeping ${sleep_s}s"
  sleep "${sleep_s}"
done
