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

function canonicalTrackedResult(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'pending';
  if (raw === 'win') return 'won';
  if (raw === 'loss') return 'lost';
  if (raw === 'placed' || raw === 'place') return 'won';
  if (['won', 'lost', 'pending', 'void'].includes(raw)) return raw;
  if (raw.startsWith('ew_')) return raw === 'ew_loss' ? 'lost' : 'won';
  return raw;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scaleSettlementValue(value, trackedStake, unitStake) {
  if (!Number.isFinite(value)) return null;
  if (!Number.isFinite(trackedStake) || trackedStake <= 0) return Number(value);
  if (!Number.isFinite(unitStake) || unitStake <= 0) return Number(value);
  return Number(value) * (Number(trackedStake) / Number(unitStake));
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Number(value) * 100) / 100;
}

function buildTrackedSettlement(row = {}, fallback = {}) {
  const result = canonicalTrackedResult(row.result || fallback.result);
  const trackedStake = toFiniteNumber(fallback.stake ?? fallback.stake_units);
  const unitStake = toFiniteNumber(row.stake_units ?? 1);
  const scaledPayout = scaleSettlementValue(toFiniteNumber(row.payout ?? row.return_units), trackedStake, unitStake);
  const scaledProfit = scaleSettlementValue(toFiniteNumber(row.profit ?? row.profit_units), trackedStake, unitStake);
  const odds = toFiniteNumber(fallback.entryOdds ?? fallback.odds ?? row.odds);

  let payout = scaledPayout;
  let profit = scaledProfit;

  if (!Number.isFinite(payout) && result === 'won' && Number.isFinite(trackedStake) && Number.isFinite(odds)) {
    payout = trackedStake * odds;
  }
  if (!Number.isFinite(profit) && Number.isFinite(payout) && Number.isFinite(trackedStake)) {
    profit = payout - trackedStake;
  }
  if (!Number.isFinite(payout) && result === 'lost' && Number.isFinite(trackedStake)) {
    payout = 0;
  }
  if (!Number.isFinite(profit) && result === 'lost' && Number.isFinite(trackedStake)) {
    profit = -trackedStake;
  }

  const roi = toFiniteNumber(row.roi ?? fallback.roi)
    ?? (Number.isFinite(profit) && Number.isFinite(trackedStake) && trackedStake > 0 ? (profit / trackedStake) : null);

  return {
    status: result === 'pending' ? 'active' : 'settled',
    result,
    settledAt: row.settledAt || row.settled_at || fallback.settledAt || null,
    payout: roundMoney(payout),
    profit: roundMoney(profit),
    roi,
    position: row.position ?? fallback.position ?? null,
    winner: row.winner ?? fallback.winner ?? null,
  };
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
  canonicalTrackedResult,
  buildTrackedSettlement,
};
