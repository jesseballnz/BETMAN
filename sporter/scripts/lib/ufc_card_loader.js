const fs = require('fs');
const path = require('path');

const SCOREBOARD_URL = process.env.SPORTER_UFC_SCOREBOARD_URL || 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
const SCOREBOARD_CACHE = path.join(CACHE_DIR, 'ufc_scoreboard.json');
const CARD_CACHE = path.join(CACHE_DIR, 'ufc_card.json');
const CACHE_TTL_MS = Number(process.env.SPORTER_SCOREBOARD_CACHE_MS || 60000);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isFresh(filePath, ttlMs) {
  try {
    const stats = fs.statSync(filePath);
    return Date.now() - stats.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sporter-ufc/1.0' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function loadScoreboard() {
  ensureDir(CACHE_DIR);
  if (isFresh(SCOREBOARD_CACHE, CACHE_TTL_MS)) {
    const cached = readJson(SCOREBOARD_CACHE);
    if (cached) return cached;
  }
  const data = await fetchJson(SCOREBOARD_URL);
  fs.writeFileSync(SCOREBOARD_CACHE, JSON.stringify(data, null, 2));
  return data;
}

function parseRecord(summary = '') {
  const parts = summary.split('-').map(part => parseInt(part, 10));
  const [wins = 0, losses = 0, draws = 0] = parts;
  return { wins, losses, draws, fights: wins + losses + draws };
}

function normalizeFights(event) {
  const fights = [];
  for (const competition of event.competitions || []) {
    if (!Array.isArray(competition.competitors) || competition.competitors.length < 2) continue;
    const competitors = competition.competitors
      .map(comp => {
        const recordSummary = comp.records?.[0]?.summary;
        return {
          id: comp.id,
          order: comp.order ?? 0,
          name: comp.athlete?.displayName || comp.athlete?.fullName || comp.athlete?.shortName,
          shortName: comp.athlete?.shortName || comp.athlete?.displayName,
          country: comp.athlete?.flag?.alt || null,
          record: parseRecord(recordSummary)
        };
      })
      .sort((a, b) => a.order - b.order);

    if (!competitors[0]?.name || !competitors[1]?.name) continue;

    fights.push({
      id: `ufc-${event.id}-${competition.id}`,
      eventId: event.id,
      eventName: event.name,
      start: competition.date,
      venue: event.venues?.[0]?.fullName || null,
      cardSegment: competition.cardSegment?.description || competition.cardSegment?.name || null,
      weightClass: competition.type?.text || null,
      rounds: competition.format?.regulation?.periods || 3,
      competitors
    });
  }
  return fights;
}

function selectEvent(scoreboard) {
  const now = Date.now();
  const upcoming = (scoreboard.events || [])
    .map(evt => ({ evt, ts: Date.parse(evt.date) || Date.parse(evt.startDate) || Number.MAX_SAFE_INTEGER }))
    .filter(item => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts);
  if (upcoming.length === 0) throw new Error('No upcoming UFC events found in scoreboard');
  const target = upcoming.find(item => item.ts >= now - 6 * 60 * 60 * 1000) || upcoming[0];
  return target.evt;
}

async function loadCard() {
  const scoreboard = await loadScoreboard();
  const event = selectEvent(scoreboard);
  const fights = normalizeFights(event);
  if (!fights.length) throw new Error('Scoreboard returned an event with no fight card data');
  const card = {
    fetchedAt: new Date().toISOString(),
    event: {
      id: event.id,
      name: event.name,
      shortName: event.shortName,
      date: event.date,
      status: event.status?.type?.description || event.status?.type?.name || null
    },
    fights
  };
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CARD_CACHE, JSON.stringify(card, null, 2));
  return card;
}

module.exports = {
  loadCard
};
