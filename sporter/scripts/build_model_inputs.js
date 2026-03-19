#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadCard } = require('./lib/ufc_card_loader');
const { modelFight } = require('./lib/ufc_model');

const SAMPLE_FEEDS = ['draftkings', 'fanduel', 'tab_sports'];
const LEAGUE_BIASES = {
  NBA: { spread: -0.5, total: -1.5, moneyline: 0.02 },
  NFL: { spread: 0.5, total: 0.5, moneyline: -0.01 },
  NRL: { spread: -1, total: -0.5, moneyline: 0.015 },
  AFL: { spread: 0, total: -3, moneyline: 0.01 },
  EPL: { spread: null, total: 0.1, moneyline: 0.02 }
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function americanToImplied(odds) {
  const num = Number(odds);
  if (!Number.isFinite(num)) return null;
  if (num > 0) return Number((100 / (num + 100)).toFixed(4));
  return Number(((-num) / ((-num) + 100)).toFixed(4));
}

function loadSampleEvents() {
  const map = new Map();
  SAMPLE_FEEDS.forEach(feed => {
    const filePath = path.join(process.cwd(), 'data', 'sample_feeds', `${feed}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      (raw.events || []).forEach(evt => {
        if (!evt || String(evt.league || '').toUpperCase() === 'UFC') return;
        if (!map.has(evt.id)) map.set(evt.id, evt);
      });
    } catch {
      // ignore missing sample feeds
    }
  });
  return [...map.values()];
}

function impliedWinSplit(moneyline = {}) {
  const home = americanToImplied(moneyline.home);
  const away = americanToImplied(moneyline.away);
  if (home === null || away === null) return null;
  let draw = null;
  if (typeof moneyline.draw === 'number') {
    draw = americanToImplied(moneyline.draw);
  }
  const total = home + away + (draw || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const normalizedHome = home / (home + away);
  const normalizedAway = away / (home + away);
  return {
    home: normalizedHome,
    away: normalizedAway
  };
}

function buildNonUfcModels() {
  const events = loadSampleEvents();
  return events.map(evt => {
    const league = String(evt.league || '').toUpperCase();
    const bias = LEAGUE_BIASES[league] || { spread: 0, total: 0, moneyline: 0 };
    const baseSpread = Number(evt.lines?.spread?.home);
    const spread = Number.isFinite(baseSpread) && bias.spread !== null
      ? Number((baseSpread + (bias.spread || 0)).toFixed(1))
      : null;
    const baseTotal = Number(evt.lines?.total?.line);
    const total = Number.isFinite(baseTotal) && bias.total !== null
      ? Number((baseTotal + (bias.total || 0)).toFixed(1))
      : null;
    const split = impliedWinSplit(evt.lines?.moneyline);
    let moneylineHomeProb = null;
    let moneylineAwayProb = null;
    if (split) {
      const adj = bias.moneyline || 0;
      moneylineHomeProb = clamp(Number((split.home + adj).toFixed(4)), 0.05, 0.95);
      moneylineAwayProb = Number((1 - moneylineHomeProb).toFixed(4));
    }
    return {
      id: evt.id,
      spread,
      total,
      moneylineHomeProb,
      moneylineAwayProb,
      home: evt.home,
      away: evt.away,
      league
    };
  }).filter(model => model.spread !== null || model.total !== null || model.moneylineHomeProb !== null);
}

async function main() {
  const card = await loadCard();
  const ufcModels = card.fights.map(fight => {
    const [home, away] = fight.competitors;
    const model = modelFight(fight);
    return {
      id: fight.id,
      spread: null,
      total: model.roundsLine,
      moneylineHomeProb: Number(model.homeWinProb.toFixed(4)),
      moneylineAwayProb: Number(model.awayWinProb.toFixed(4)),
      home: home.name,
      away: away.name,
      league: 'UFC'
    };
  });
  const multiSportModels = buildNonUfcModels();
  const allModels = [...ufcModels, ...multiSportModels];
  const out = {
    updatedAt: new Date().toISOString(),
    models: allModels
  };
  const outPath = path.join(process.cwd(), 'data', 'model_inputs.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `Model inputs updated: ${allModels.length} events (${ufcModels.length} UFC + ${multiSportModels.length} multi-sport) -> ${outPath}`
  );
}

main().catch(err => {
  console.error('build_model_inputs failed', err.message);
  process.exit(1);
});
