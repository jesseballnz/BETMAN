'use strict';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeMeeting(value) {
  return normalizeText(value);
}

function normalizeRace(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/(\d+)/);
  return match ? String(Number(match[1])) : normalizeText(raw);
}

function normalizeSelection(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw
    .replace(/^\s*(?:#?\d+|\(\d+\))\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*runner\s*\d+\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*emerg(?:ency)?\s*\d+\s*[.\-:)]*\s*/i, '');
  return normalizeText(raw);
}

function normalizeBetType(value) {
  const raw = normalizeText(value);
  if (!raw) return 'win';
  if (['w', 'win', 'winner', 'fixed win', 'to win', 'single win'].includes(raw)) return 'win';
  if (['ew', 'e w', 'each way', 'eachway'].includes(raw)) return 'ew';
  if (['odds runner', 'oddsrunner'].includes(raw)) return 'odds_runner';
  const topMatch = raw.match(/^top\s*(\d+)$/);
  if (topMatch) return `top${topMatch[1]}`;
  if (raw === 'quinella') return 'top2';
  if (raw === 'trifecta') return 'trifecta';
  if (raw === 'first 4' || raw === 'first4') return 'top4';
  return raw.replace(/\s+/g, '_');
}

function betTypeFamily(value) {
  const type = normalizeBetType(value);
  if (type === 'win' || type === 'ew' || type === 'odds_runner') return 'single_runner';
  if (/^top\d+$/.test(type)) return 'topn';
  return type;
}

function buildComparableBet(row = {}) {
  return {
    meeting: normalizeMeeting(row.meeting),
    race: normalizeRace(row.race),
    selection: normalizeSelection(row.selection),
    type: normalizeBetType(row.betType || row.type),
    family: betTypeFamily(row.betType || row.type),
  };
}

function matchSettledBet(trackedBet, settledRows) {
  const tracked = buildComparableBet(trackedBet);
  if (!tracked.meeting || !tracked.race || !tracked.selection) return null;
  const rows = Array.isArray(settledRows) ? settledRows : [];
  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    const settled = buildComparableBet(row);
    if (settled.meeting !== tracked.meeting) continue;
    if (settled.race !== tracked.race) continue;
    if (settled.selection !== tracked.selection) continue;

    let score = 0;
    if (settled.type === tracked.type) score = 3;
    else if (settled.family === tracked.family) score = 2;
    else continue;

    if (score > bestScore) {
      best = row;
      bestScore = score;
      if (score === 3) break;
    }
  }

  return best;
}

function buildSettledBetKey(row = {}) {
  const normalized = buildComparableBet(row);
  return `${normalized.meeting}|${normalized.race}|${normalized.selection}|${normalized.type}`;
}

module.exports = {
  normalizeText,
  normalizeMeeting,
  normalizeRace,
  normalizeSelection,
  normalizeBetType,
  betTypeFamily,
  buildComparableBet,
  matchSettledBet,
  buildSettledBetKey,
};
