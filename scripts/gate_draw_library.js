#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAB_DIR = path.join(ROOT, 'data', 'tab');
const OUT_MEMORY = path.join(ROOT, 'memory', 'gate_draw_library.json');
const OUT_FRONTEND = path.join(ROOT, 'frontend', 'data', 'gate_draw_library.json');

function readJson(p){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function distanceBand(m){
  const d = Number(m || 0);
  if (!Number.isFinite(d) || d <= 0) return 'unknown';
  if (d <= 1200) return 'sprint';
  if (d <= 1600) return 'mile';
  if (d <= 2200) return 'middle';
  return 'staying';
}

function keyOf(race){
  const country = String(race.country || 'UNK').toUpperCase();
  const meeting = String(race.display_meeting_name || race.meeting_name || 'UNKNOWN').toUpperCase();
  const band = distanceBand(race.distance);
  const field = Number(race.field_size || race.entrant_count || 0);
  const fieldBand = field <= 8 ? 'small' : field <= 12 ? 'mid' : 'large';
  return `${country}|${meeting}|${band}|${fieldBand}`;
}

function scanEvents(dir){
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name === 'event.json') out.push(p);
    }
  }
  return out;
}

function build(){
  const files = scanEvents(TAB_DIR);
  const groups = new Map();
  let totalRaces = 0;

  files.forEach(file => {
    const payload = readJson(file);
    const race = payload?.data?.race;
    const results = payload?.data?.results || [];
    if (!race || !Array.isArray(results) || !results.length) return;
    const winner = results.find(x => Number(x?.position) === 1);
    if (!winner) return;
    const winBarrier = Number(winner.barrier || 0);
    if (!Number.isFinite(winBarrier) || winBarrier <= 0) return;

    const key = keyOf(race);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        country: String(race.country || 'UNK').toUpperCase(),
        meeting: String(race.display_meeting_name || race.meeting_name || 'UNKNOWN'),
        distanceBand: distanceBand(race.distance),
        fieldBand: (Number(race.field_size || race.entrant_count || 0) <= 8) ? 'small' : (Number(race.field_size || race.entrant_count || 0) <= 12 ? 'mid' : 'large'),
        starts: 0,
        winsByBarrier: {}
      });
    }
    const row = groups.get(key);
    row.starts += 1;
    row.winsByBarrier[winBarrier] = (row.winsByBarrier[winBarrier] || 0) + 1;
    totalRaces += 1;
  });

  const buckets = [...groups.values()].map(g => {
    const barrierStats = Object.entries(g.winsByBarrier)
      .map(([barrier, wins]) => ({
        barrier: Number(barrier),
        wins,
        winPct: Number(((wins / g.starts) * 100).toFixed(2))
      }))
      .sort((a, b) => a.barrier - b.barrier);
    return {
      ...g,
      barrierStats,
      topBarriers: barrierStats.slice().sort((a, b) => b.winPct - a.winPct).slice(0, 5)
    };
  }).sort((a, b) => b.starts - a.starts);

  return {
    generatedAt: new Date().toISOString(),
    racesSampled: totalRaces,
    buckets
  };
}

function writeOut(p, data){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

const report = build();
writeOut(OUT_MEMORY, report);
writeOut(OUT_FRONTEND, report);
console.log(`gate draw library updated: ${report.racesSampled} races -> ${OUT_MEMORY}`);
