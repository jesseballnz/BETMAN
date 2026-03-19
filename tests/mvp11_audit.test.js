#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dataDir = path.join(ROOT, 'frontend', 'data');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout || '';
}

function nzToday() {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function parseOdds(reason) {
  const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function parseP(reason) {
  const m = String(reason || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function whyClass(row, stakePerRace = 7) {
  const reason = String(row.reason || '').toLowerCase();
  const type = String(row.type || '').toLowerCase();
  const p = parseP(reason);
  const odds = parseOdds(reason);
  const stake = Number(row.stake || 0);
  const exotic = ['top2','top3','top4','trifecta','multi'].includes(type);

  return {
    STRONG: (!exotic) && ((Number.isFinite(p) && p >= 24) || stake >= Number(stakePerRace || 0)),
    VALUE: (!exotic) && (type === 'ew' || (Number.isFinite(odds) && odds >= 5) || (Number.isFinite(p) && p < 20) || reason.includes('value') || reason.includes('long-odds')),
    EXOTIC: exotic
  };
}

(function main() {
  const date = nzToday();

  // Rebuild a fresh HK snapshot for deterministic audit checks.
  run('node', [
    'scripts/racing_poller.js',
    '--countries=HK',
    `--date=${date}`,
    '--status=',
    '--meetings=',
    '--long_odds=12',
    '--recent_window=3',
    '--recent_top3=2',
    '--standout_prob=0.35',
    '--standout_ratio=1.8',
    '--split_top1=0.6',
    '--ew_win_min=10',
    '--ew_place_min=3'
  ]);
  run('node', ['scripts/status_writer.js']);
  run('node', ['scripts/race_cache_writer.js']);

  const status = loadJson(path.join(dataDir, 'status.json'));
  const races = loadJson(path.join(dataDir, 'races.json'));
  const appJs = fs.readFileSync(path.join(ROOT, 'frontend', 'app.js'), 'utf8');

  // 1) Suggested bets shape + coherence for Win rows when present.
  const suggested = Array.isArray(status.suggestedBets) ? status.suggestedBets : [];
  const winRows = suggested.filter(x => String(x.type || '').toLowerCase() === 'win');
  for (const r of winRows) {
    const o = parseOdds(r.reason);
    assert(Number.isFinite(o) && o > 1, `Win row missing parsable odds: ${r.reason}`);
    if (Number.isFinite(Number(r.aiWinProb))) {
      assert(Number(r.aiWinProb) > 0 && Number(r.aiWinProb) < 100, 'aiWinProb out of bounds');
    }
  }

  // 2) Multis/exotics structure check when present.
  const exotics = suggested.filter(x => ['top2', 'top3', 'top4', 'trifecta', 'multi'].includes(String(x.type || '').toLowerCase()));
  for (const x of exotics) {
    const sel = String(x.selection || '');
    assert(sel.length >= 3, 'exotic selection too short');
    assert(/\/|>| x /i.test(sel), `exotic selection not structured: ${sel}`);
  }

  // 3) Interesting runners HK spread check when HK rows are present.
  const hkInteresting = (status.interestingRunners || []).filter(r => String(r.meeting || '').toLowerCase().includes('happy valley'));
  if (hkInteresting.length) {
    const hkRaceSet = new Set(hkInteresting.map(r => String(r.race)));
    assert(hkRaceSet.size >= 3, `HK interesting coverage too narrow: ${[...hkRaceSet].join(',')}`);
  }

  // 4) Market movers schema should include horizon fields when rows present.
  const movers = Array.isArray(status.marketMovers) ? status.marketMovers : [];
  if (movers.length) {
    const m = movers[0];
    for (const k of ['change1m', 'change5m', 'change30m', 'change1h', 'change5h']) {
      assert(Object.prototype.hasOwnProperty.call(m, k), `market mover missing ${k}`);
    }
  }

  // 5) Race cache should provide HK runner odds via fixed/tote fallback when HK races are present.
  const hkRaces = (races.races || []).filter(r => String(r.country || '').toUpperCase() === 'HK');
  if (hkRaces.length) {
    const hkOdds = hkRaces.flatMap(r => (r.runners || []).map(x => Number(x.odds))).filter(Number.isFinite);
    assert(hkOdds.length > 0, 'HK runner odds missing in cache');
  }

  // 6) WHY flag behavior sanity (Strong / Value / Exotic).
  const sampleStrong = { type: 'Win', stake: 7, reason: 'p=26.0% @ 3.2' };
  const sampleValue = { type: 'Win', stake: 2, reason: 'p=16.0% @ $7.5 long-odds' };
  const sampleExotic = { type: 'Top3', stake: 1, reason: 'Top-3 profile from adjusted win probabilities' };
  const s = whyClass(sampleStrong, 7);
  const v = whyClass(sampleValue, 7);
  const e = whyClass(sampleExotic, 7);
  assert(s.STRONG === true && s.EXOTIC === false, 'WHY STRONG classification failed');
  assert(v.VALUE === true && v.EXOTIC === false, 'WHY VALUE classification failed');
  assert(e.EXOTIC === true && e.STRONG === false, 'WHY EXOTIC classification failed');

  // 7) Code-level invariants for MVP1.1 behavior.
  assert(appJs.includes("if (page !== 'workspace' && selectedMeeting === 'ALL')"), 'workspace tab gating missing');
  assert(appJs.includes('NZ') && appJs.includes('AUS') && appJs.includes('HK'), 'country fallback chain not present');
  assert(appJs.includes('@\\s*\\$?\\s*([0-9]+(?:\\.[0-9]+)?)'), 'frontend odds parser should accept $ format');

  console.log('mvp1.1 audit tests passed');
})();
