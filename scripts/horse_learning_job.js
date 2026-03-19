#!/usr/bin/env node
/* Build a lightweight horse learning cache from races.json + LoveRacing enrichments when available. */
const fs = require('fs');
const path = require('path');

function loadJson(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const ROOT = path.resolve(__dirname, '..');
const racesPath = path.join(ROOT, 'frontend', 'data', 'races.json');
const outPath = path.join(ROOT, 'memory', 'horse-learning-cache.json');

const racesData = loadJson(racesPath, { races: [], updatedAt: null, date: null });
const cache = {};

for (const race of (racesData.races || [])) {
  for (const rr of (race.runners || [])) {
    const name = String(rr.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const rec = cache[key] || {
      horse: name,
      seenRaces: 0,
      countries: new Set(),
      meetings: new Set(),
      latest: null,
      loveracingNotes: []
    };

    rec.seenRaces += 1;
    rec.countries.add(String(race.country || '').toUpperCase());
    rec.meetings.add(String(race.meeting || '').trim());

    rec.latest = {
      meeting: race.meeting,
      race: race.race_number,
      country: race.country,
      barrier: rr.barrier ?? null,
      jockey: rr.jockey || null,
      trainer: rr.trainer || null,
      weight: rr.weight ?? null,
      odds: rr.odds ?? rr.fixed_win ?? rr.tote_win ?? null,
      form: rr.last_twenty_starts || null,
      sire: rr.sire || null,
      dam: rr.dam || null,
      damSire: rr.dam_sire || null,
      speedmap: rr.speedmap || null,
      trackCondition: race.track_condition || null,
      distance: race.distance || null
    };

    if (rr.loveracing_note) rec.loveracingNotes.push(rr.loveracing_note);
    cache[key] = rec;
  }
}

const out = Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, {
  horse: v.horse,
  seenRaces: v.seenRaces,
  countries: Array.from(v.countries),
  meetings: Array.from(v.meetings),
  latest: v.latest,
  loveracingNotes: v.loveracingNotes.slice(0, 6)
}]));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  updatedAt: new Date().toISOString(),
  racesUpdatedAt: racesData.updatedAt || null,
  date: racesData.date || null,
  horses: out
}, null, 2));

console.log(`horse learning cache updated: ${Object.keys(out).length} horses`);
