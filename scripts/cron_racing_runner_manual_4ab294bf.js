const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const base = path.resolve(__dirname, '..');
process.chdir(base);
fs.mkdirSync(path.join(base, 'memory'), { recursive: true });
const statePath = path.join(base, 'memory', 'racing-poll-state.json');
const prevPath = path.join(base, 'memory', 'racing-poll-state.pre-cron.json');
if (fs.existsSync(statePath)) fs.copyFileSync(statePath, prevPath);

const steps = [
  ['scripts/meeting_profile.js', ['--date=today', '--country=AUS']],
  ['scripts/meeting_profile.js', ['--date=today', '--country=NZ', '--loveracing=true']],
  ['scripts/racing_poller.js', ['--countries=NZ,AUS,HK', '--status=', '--meetings=', '--long_odds=12', '--recent_window=3', '--recent_top3=2', '--standout_prob=0.35', '--standout_ratio=1.8', '--split_top1=0.6', '--ew_win_min=10', '--ew_place_min=3', '--move=0.015']],
  ['scripts/status_writer.js', []],
  ['scripts/race_cache_writer.js', []],
];

const logs = [];
for (const [script, args] of steps) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: base,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  logs.push({ script, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' });
  if (res.status !== 0) {
    console.error(JSON.stringify({ failed: script, logs }, null, 2));
    process.exit(res.status ?? 1);
  }
}

function load(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function bestWinOdds(r) {
  return Number(r?.fixed_win ?? r?.odds?.fixed_win ?? r?.win_odds ?? r?.win ?? r?.spr ?? NaN);
}
const prev = load(prevPath, { races: {} });
const curr = load(statePath, { races: {}, candidates: [] });
const now = new Date();
const moves = [];
for (const [raceKey, race] of Object.entries(curr.races || {})) {
  const prevRace = prev.races?.[raceKey];
  if (!prevRace) continue;
  let mins = null;
  const raw = race.advertised_start || race.start_time_nz || null;
  if (raw != null) {
    const startMs = (typeof raw === 'number' && raw < 1e12) ? raw * 1000 : raw;
    const d = new Date(startMs);
    if (!isNaN(d)) mins = (d - now) / 60000;
  }
  if (!(mins !== null && mins >= 0 && mins <= 5)) continue;
  const prevOdds = Object.fromEntries((prevRace.runners || []).map(x => [x.runner_name, bestWinOdds(x)]));
  for (const rr of (race.runners || [])) {
    const old = prevOdds[rr.runner_name];
    const cur = bestWinOdds(rr);
    if (!Number.isFinite(old) || !Number.isFinite(cur) || old <= 0 || cur <= 0) continue;
    const change = (cur - old) / old;
    if (Math.abs(change) >= 0.015) {
      moves.push({
        race: raceKey,
        runner: rr.runner_name,
        old,
        now: cur,
        pct: Math.round(change * 1000) / 10,
        mins: Math.round(mins * 10) / 10,
      });
    }
  }
}
const candidates = (curr.candidates || [])
  .filter(c => Number.isFinite(c.mins_to_start) && c.mins_to_start >= 0 && c.mins_to_start <= 10 && Number(c.odds) >= 12)
  .map(c => ({
    race: c.race,
    runner: c.runner,
    odds: c.odds,
    last: c.last,
    barrier: c.barrier,
    jockey: c.jockey,
    trainer: c.trainer,
    mins: c.mins_to_start,
    blocked: c.blocked_reason || null,
  }));
console.log(JSON.stringify({ moves, candidates, logs }, null, 2));
