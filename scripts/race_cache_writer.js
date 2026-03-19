#!/usr/bin/env node
/* Write frontend/data/races.json from poller state (upcoming only). */
const fs = require('fs');
const path = require('path');

function loadJson(p, fallback){
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fallback; }
}

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');
const statePath = path.join(ROOT, 'memory', 'racing-poll-state.json');
const state = loadJson(statePath, null);
if (!state) process.exit(1);

function bestOdds(x){
  const f = Number(x?.fixed_win || 0);
  if (Number.isFinite(f) && f > 0) return f;
  const t = Number(x?.tote_win || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return null;
}

function normHorseName(name){
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractRacingAusMetrics(runner = {}) {
  const indicators = Array.isArray(runner.form_indicators) ? runner.form_indicators : [];
  const trialIndicator = indicators.some(ind => {
    const name = String(ind?.name || '').toLowerCase();
    const group = String(ind?.group || '').toLowerCase();
    return name.includes('trial') || group.includes('trial');
  });
  const past = Array.isArray(runner.past_performances) ? runner.past_performances : [];
  const sectionals = past
    .map(p => Number(p?.last_600 || p?.last600 || p?.last_six_hundred || NaN))
    .filter(v => Number.isFinite(v));
  const last600Best = sectionals.length ? Math.min(...sectionals) : null;
  const last600Avg = sectionals.length ? (sectionals.reduce((a,b)=>a+b,0) / sectionals.length) : null;
  return {
    available: true,
    trial_indicator: trialIndicator,
    sectionals_available: sectionals.length > 0,
    sectionals_count: sectionals.length,
    last600_best: Number.isFinite(last600Best) ? Number(last600Best.toFixed(2)) : null,
    last600_avg: Number.isFinite(last600Avg) ? Number(last600Avg.toFixed(2)) : null
  };
}

const statusPath = path.join(ROOT, 'frontend', 'data', 'status.json');
const status = loadJson(statusPath, {});
const loveracingCachePath = path.join(ROOT, 'memory', 'loveracing_horse_cache.json');
const loveracingCache = loadJson(loveracingCachePath, {});
const loveracingMap = new Map(Object.entries(loveracingCache || {}));
const keepSet = new Set();
for (const row of (status.suggestedBets || [])) {
  if (row?.meeting && row?.race) keepSet.add(`${String(row.meeting).trim().toLowerCase()}|${String(row.race).replace(/^R/i,'').trim()}`);
}
for (const row of (status.interestingRunners || [])) {
  if (row?.meeting && row?.race) keepSet.add(`${String(row.meeting).trim().toLowerCase()}|${String(row.race).replace(/^R/i,'').trim()}`);
}
for (const row of (status.marketMovers || [])) {
  if (row?.meeting && row?.race) keepSet.add(`${String(row.meeting).trim().toLowerCase()}|${String(row.race).replace(/^R/i,'').trim()}`);
}

const races = Object.entries(state.races || {})
  .filter(([_, r]) => {
    const status = String(r.race_status || '').toLowerCase();
    if (['abandoned'].includes(status)) return false;
    if (['final','closed','resulted'].includes(status)) {
      const key = `${String(r.meeting||'').trim().toLowerCase()}|${String(r.race_number||'').trim()}`;
      return keepSet.has(key);
    }
    return true;
  })
  .map(([key, r]) => ({
    key,
    country: key.split(':')[0],
    meeting: r.meeting,
    race_number: r.race_number,
    description: r.description,
    start_time_nz: r.start_time_nz,
    advertised_start: r.advertised_start,
    track_condition: r.track_condition,
    distance: r.distance,
    rail_position: r.rail_position,
    race_status: r.race_status,
    runners: (r.runners || []).map(x => {
      const lr = loveracingMap.get(normHorseName(x.runner_name));
      return {
        runner_number: x.runner_number,
        name: x.runner_name,
        barrier: x.barrier,
        jockey: x.jockey,
        trainer: x.trainer,
        trainer_location: x.trainer_location,
        owners: x.owners,
        gear: x.gear,
        age: x.age,
        sex: x.sex,
        colour: x.colour,
        country: x.country,
        favourite: x.favourite,
        mover: x.mover,
        form_comment: x.form_comment,
        allowance_weight: x.allowance_weight,
        apprentice_indicator: x.apprentice_indicator,
        weight: x.weight_total || x.weight_allocated,
        rating: x.rating,
        handicap_rating: x.handicap_rating,
        win_p: x.win_p,
        place_p: x.place_p,
        spr: x.spr,
        odds: bestOdds(x),
        fixed_win: x.fixed_win,
        tote_win: x.tote_win,
        fixed_place: x.fixed_place,
        tote_place: x.tote_place,
        is_scratched: x.is_scratched,
        sire: x.sire,
        dam: x.dam,
        dam_sire: x.dam_sire,
        dam_dam: x.dam_dam,
        breeding: x.breeding,
        last_twenty_starts: x.last_twenty_starts,
        last_starts: x.last_starts,
        speedmap: x.speedmap,
        silk_url_64x64: x.silk_url_64x64,
        silk_url_128x128: x.silk_url_128x128,
        silk_colours: x.silk_colours,
        ride_guide_exists: x.ride_guide_exists,
        ride_guide_thumbnail: x.ride_guide_thumbnail,
        ride_guide_file: x.ride_guide_file,
        stats: x.stats,
        form_indicators: x.form_indicators || null,
        past_performances: x.past_performances || null,
        racingaus: extractRacingAusMetrics(x),
        loveracing: lr || null
      };
    })
  }));

const outDir = path.join(ROOT, 'frontend', 'data');
const outPath = path.join(outDir, 'races.json');
const datedPath = path.join(outDir, `races-${state.date}.json`);
const payload = { updatedAt: state.ts, date: state.date, races };
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2));
try {
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'races.json'), JSON.stringify(payload, null, 2));
} catch {}
console.log('races.json updated');

if (process.env.DATABASE_URL || process.env.BETMAN_DATABASE_URL) {
  const { spawnSync } = require('child_process');
  spawnSync('node', [path.join(ROOT, 'scripts', 'db_sync.js'), '--tenant=default', `--keys=races.json,races-${state.date}.json`, '--audit=none'], { stdio: 'ignore' });
}
