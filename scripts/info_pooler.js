#!/usr/bin/env node
/*
  BETMAN information pooler
  Adapters:
  - local-race-cache
  - loveracing-cache
  - racingaus-cache
  - weather (wttr.in)
  - news (Google News RSS)
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'frontend', 'data');
const POOL_DIR = path.join(DATA_DIR, 'pool');
const POOL_FILE = path.join(POOL_DIR, 'runner_intel.ndjson');
const INDEX_FILE = path.join(POOL_DIR, 'index.json');
const SUMMARY_FILE = path.join(POOL_DIR, 'summary.json');
const WEATHER_CACHE_FILE = path.join(POOL_DIR, 'weather_cache.json');
const NEWS_CACHE_FILE = path.join(POOL_DIR, 'news_cache.json');
const LOVERACING_CACHE_FILE = path.join(DATA_DIR, 'loveracing', 'horse_cache.json');

const WEATHER_TTL_MS = 6 * 60 * 60 * 1000;
const NEWS_TTL_MS = 12 * 60 * 60 * 1000;

function ensureDir(dir){
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readJson(file, fallback = {}){ try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function norm(v){ return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function asNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function appendNdjson(file, rows){ if (!rows.length) return; fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'); }

function parseStartTs(v){
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
}

function loadTargets(){
  const races = readJson(path.join(DATA_DIR, 'races.json'), {}).races || [];
  const targets = [];
  races.forEach(race => {
    const meeting = race.meeting || '';
    const raceNo = race.race_number || race.race || '';
    const raceKey = race.key || `${norm(race.country)}|${norm(meeting)}|${raceNo}`;
    (race.runners || []).forEach(runner => {
      const name = runner.name || runner.runner_name;
      if (!name) return;
      targets.push({ race, runner, meeting, raceNo, raceKey, runnerName: name });
    });
  });
  return targets;
}

function mkBaseRecord(target){
  const now = new Date().toISOString();
  const sourceDate = now.slice(0, 10);
  const { race, runner, meeting, raceNo, raceKey, runnerName } = target;
  const runnerKey = `${norm(meeting)}|${raceNo}|${norm(runnerName)}`;
  return { now, sourceDate, race, runner, meeting, raceNo, raceKey, runnerName, runnerKey };
}

function localAdapter(target){
  const b = mkBaseRecord(target);
  const odds = asNum(b.runner.odds || b.runner.fixed_win || b.runner.tote_win);
  const implied = odds && odds > 0 ? +(100 / odds).toFixed(3) : null;
  return {
    key: `local:${b.sourceDate}:${b.runnerKey}`,
    source: 'local-race-cache',
    capturedAt: b.now,
    sourceDate: b.sourceDate,
    entity: {
      meeting: b.meeting, race: b.raceNo, raceKey: b.raceKey, runner: b.runnerName, runnerKey: b.runnerKey,
      country: b.race.country || null
    },
    market: { odds, implied, placeOdds: asNum(b.runner.fixed_place || b.runner.tote_place || b.runner.place_odds) },
    profile: {
      barrier: b.runner.barrier || null, weight: b.runner.weight || null, jockey: b.runner.jockey || null,
      trainer: b.runner.trainer || null, trainerLocation: b.runner.trainer_location || null,
      age: b.runner.age || null, sex: b.runner.sex || null,
      sire: b.runner.sire || null, dam: b.runner.dam || null, damSire: b.runner.dam_sire || null,
      speedmap: b.runner.speedmap || null, form: b.runner.last_twenty_starts || b.runner.form || null,
      formComment: b.runner.form_comment || null
    },
    stats: {
      winP: asNum(b.runner.win_p), placeP: asNum(b.runner.place_p), rating: asNum(b.runner.rating),
      handicapRating: asNum(b.runner.handicap_rating), spr: asNum(b.runner.spr),
      overall: b.runner.stats?.overall || null, track: b.runner.stats?.track || null, distance: b.runner.stats?.distance || null,
      firstUp: b.runner.stats?.first_up || null, secondUp: b.runner.stats?.second_up || null
    },
    sourceTags: { hasLoveracing: !!b.runner.loveracing, hasRacingAus: !!b.runner.racingaus },
    raceMeta: {
      description: b.race.description || null, distance: b.race.distance || null, trackCondition: b.race.track_condition || null,
      railPosition: b.race.rail_position || null, weather: b.race.weather || null,
      raceStatus: b.race.race_status || null, advertisedStart: b.race.advertised_start || null, startTimeNz: b.race.start_time_nz || null
    }
  };
}

function loveracingAdapter(target, loveracingMap){
  const b = mkBaseRecord(target);
  const lr = loveracingMap[norm(b.runnerName)] || b.runner.loveracing;
  if (!lr || typeof lr !== 'object') return null;
  return {
    key: `loveracing:${b.sourceDate}:${b.runnerKey}`,
    source: 'loveracing-cache',
    capturedAt: b.now,
    sourceDate: b.sourceDate,
    entity: { meeting: b.meeting, race: b.raceNo, raceKey: b.raceKey, runner: b.runnerName, runnerKey: b.runnerKey },
    loveracing: {
      horseId: lr.horse_id || null,
      trainer: lr.trainer || null,
      domesticRating: asNum(lr.domestic_rating),
      sectionals: lr.sectionals || null,
      comments: Array.isArray(lr.comments) ? lr.comments.slice(0, 6) : []
    }
  };
}

function racingAusAdapter(target){
  const b = mkBaseRecord(target);
  const ra = b.runner.racingaus;
  if (!ra || typeof ra !== 'object') return null;
  return {
    key: `racingaus:${b.sourceDate}:${b.runnerKey}`,
    source: 'racingaus-cache',
    capturedAt: b.now,
    sourceDate: b.sourceDate,
    entity: { meeting: b.meeting, race: b.raceNo, raceKey: b.raceKey, runner: b.runnerName, runnerKey: b.runnerKey },
    racingaus: {
      available: !!ra.available,
      trialIndicator: !!ra.trial_indicator,
      sectionalsAvailable: !!ra.sectionals_available,
      sectionalsCount: asNum(ra.sectionals_count),
      last600Best: asNum(ra.last600_best),
      last600Avg: asNum(ra.last600_avg)
    }
  };
}

async function fetchWeather(meeting, cache){
  const key = norm(meeting);
  if (!key) return null;
  const hit = cache[key];
  if (hit && (Date.now() - Date.parse(hit.capturedAt || 0)) < WEATHER_TTL_MS) return hit.payload;

  try {
    const url = `https://wttr.in/${encodeURIComponent(meeting)}?format=j1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BETMAN-InfoPooler/1.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const current = json?.current_condition?.[0] || {};
    const payload = {
      tempC: asNum(current.temp_C),
      humidity: asNum(current.humidity),
      windKmph: asNum(current.windspeedKmph),
      weatherDesc: current.weatherDesc?.[0]?.value || null,
      feelsLikeC: asNum(current.FeelsLikeC)
    };
    cache[key] = { capturedAt: new Date().toISOString(), payload };
    return payload;
  } catch {
    return null;
  }
}

async function fetchNews(meeting, cache){
  const key = norm(meeting);
  if (!key) return [];
  const hit = cache[key];
  if (hit && (Date.now() - Date.parse(hit.capturedAt || 0)) < NEWS_TTL_MS) return hit.items || [];

  try {
    const q = encodeURIComponent(`${meeting} horse racing`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-NZ&gl=NZ&ceid=NZ:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BETMAN-InfoPooler/1.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) && items.length < 6) {
      const block = match[1] || '';
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
      const link = (block.match(/<link>(.*?)<\/link>/)?.[1] || '').trim();
      if (title && link) items.push({ title, link });
    }
    cache[key] = { capturedAt: new Date().toISOString(), items };
    return items;
  } catch {
    return [];
  }
}

async function main(){
  ensureDir(POOL_DIR);
  const index = readJson(INDEX_FILE, { keys: {} });
  index.keys = index.keys || {};

  const weatherCache = readJson(WEATHER_CACHE_FILE, {});
  const newsCache = readJson(NEWS_CACHE_FILE, {});
  const loveracingMap = readJson(LOVERACING_CACHE_FILE, {});

  const targets = loadTargets();
  const rows = [];

  const meetings = Array.from(new Set(targets.map(t => t.meeting).filter(Boolean)));
  const meetingWeather = {};
  const meetingNews = {};

  for (const meeting of meetings) {
    meetingWeather[norm(meeting)] = await fetchWeather(meeting, weatherCache);
    meetingNews[norm(meeting)] = await fetchNews(meeting, newsCache);
  }

  for (const target of targets) {
    const local = localAdapter(target);
    const lr = loveracingAdapter(target, loveracingMap);
    const ra = racingAusAdapter(target);
    const weather = meetingWeather[norm(target.meeting)]
      ? {
          key: `weather:${local.sourceDate}:${norm(target.meeting)}`,
          source: 'weather-wttr',
          capturedAt: local.capturedAt,
          sourceDate: local.sourceDate,
          entity: { meeting: target.meeting, country: target.race.country || null },
          weather: meetingWeather[norm(target.meeting)]
        }
      : null;
    const newsItems = meetingNews[norm(target.meeting)] || [];
    const news = newsItems.length
      ? {
          key: `news:${local.sourceDate}:${norm(target.meeting)}`,
          source: 'news-google-rss',
          capturedAt: local.capturedAt,
          sourceDate: local.sourceDate,
          entity: { meeting: target.meeting, country: target.race.country || null },
          news: newsItems
        }
      : null;

    for (const rec of [local, lr, ra, weather, news]) {
      if (!rec?.key) continue;
      if (index.keys[rec.key]) continue;
      index.keys[rec.key] = rec.capturedAt;
      rows.push(rec);
    }
  }

  appendNdjson(POOL_FILE, rows);
  writeJson(INDEX_FILE, index);
  writeJson(WEATHER_CACHE_FILE, weatherCache);
  writeJson(NEWS_CACHE_FILE, newsCache);

  const bySource = rows.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {});
  const summary = {
    updatedAt: new Date().toISOString(),
    added: rows.length,
    addedBySource: bySource,
    totalIndexed: Object.keys(index.keys || {}).length,
    targetsScanned: targets.length,
    meetingsScanned: meetings.length,
    poolFile: path.relative(ROOT, POOL_FILE)
  };
  writeJson(SUMMARY_FILE, summary);

  console.log(`info_pooler: added ${rows.length} rows (indexed ${summary.totalIndexed})`);
  console.log(`sources: ${Object.entries(bySource).map(([k,v]) => `${k}:${v}`).join(' | ') || 'none'}`);
}

main().catch(err => {
  console.error('info_pooler_failed', err?.message || err);
  process.exit(1);
});
