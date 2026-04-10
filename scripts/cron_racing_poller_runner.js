#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const steps = [
  ['scripts/meeting_profile.js', ['--date=today', '--country=AUS']],
  ['scripts/meeting_profile.js', ['--date=today', '--country=NZ', '--loveracing=true']],
  ['scripts/racing_poller.js', ['--countries=NZ,AUS,HK', '--status=', '--meetings=', '--long_odds=12', '--recent_window=3', '--recent_top3=2', '--standout_prob=0.35', '--standout_ratio=1.8', '--split_top1=0.6', '--ew_win_min=10', '--ew_place_min=3']],
  ['scripts/status_writer.js', []],
  ['scripts/race_cache_writer.js', []],
];

for (const [file, args] of steps) {
  const res = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit', cwd: process.cwd(), env: process.env });
  if (res.status !== 0) process.exit(res.status || 1);
}
