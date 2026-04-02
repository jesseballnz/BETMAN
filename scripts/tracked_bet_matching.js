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

function buildRaceResultIndex(settledRows = []) {
  const rows = Array.isArray(settledRows) ? settledRows : [];
  const byRace = new Map();

  for (const row of rows) {
    const comparable = buildComparableBet(row);
    if (!comparable.meeting || !comparable.race) continue;
    const key = `${comparable.meeting}|${comparable.race}`;
    const current = byRace.get(key) || {
      meeting: row.meeting,
      race: normalizeRace(row.race),
      winner: null,
      positions: new Map(),
      rows: [],
      settledAt: null,
    };

    current.rows.push(row);
    if (!current.settledAt && (row.settledAt || row.settled_at)) {
      current.settledAt = row.settledAt || row.settled_at;
    }

    const winnerName = row.winner || null;
    if (winnerName && !current.winner) current.winner = winnerName;

    const position = Number(row.position);
    const selection = row.selection || null;
    if (Number.isFinite(position) && selection) {
      current.positions.set(normalizeSelection(selection), position);
      if (position === 1 && !current.winner) current.winner = selection;
    }

    byRace.set(key, current);
  }

  return byRace;
}

function buildTrackedSettlementSource(trackedBet, settledRows, raceResultIndex = null) {
  const tracked = buildComparableBet(trackedBet);
  if (!tracked.meeting || !tracked.race || !tracked.selection) return null;
  const rows = Array.isArray(settledRows) ? settledRows : [];
  const raceMap = raceResultIndex instanceof Map ? raceResultIndex : buildRaceResultIndex(rows);
  const raceKey = `${tracked.meeting}|${tracked.race}`;
  const raceResult = raceMap.get(raceKey) || null;
  const trackedType = normalizeBetType(trackedBet.betType || trackedBet.type);

  let exactMatch = null;
  let familyMatch = null;
  const raceRows = raceResult?.rows || [];

  for (const row of raceRows) {
    const settled = buildComparableBet(row);
    if (settled.selection !== tracked.selection) continue;
    if (settled.type === tracked.type) {
      exactMatch = row;
      break;
    }
    if (!familyMatch && settled.family === tracked.family) {
      familyMatch = row;
    }
  }

  if (exactMatch) return { kind: 'settled-row', row: exactMatch, raceResult };
  if (!raceResult) return familyMatch ? { kind: 'settled-row', row: familyMatch, raceResult } : null;
  if (trackedType !== 'win' && trackedType !== 'ew') return familyMatch ? { kind: 'settled-row', row: familyMatch, raceResult } : null;

  const winnerNorm = normalizeSelection(raceResult.winner);
  const trackedSelection = tracked.selection;
  const position = raceResult.positions.get(trackedSelection) ?? (winnerNorm === trackedSelection ? 1 : null);

  if (trackedType === 'win') {
    if (!winnerNorm) {
      return familyMatch ? { kind: 'settled-row', row: familyMatch, raceResult } : null;
    }
    const result = winnerNorm === trackedSelection ? 'win' : 'loss';
    return {
      kind: 'race-result',
      row: {
        meeting: trackedBet.meeting,
        race: trackedBet.race,
        selection: trackedBet.selection,
        type: trackedType,
        result,
        position,
        winner: raceResult.winner || trackedBet.selection,
        settled_at: raceResult.settledAt || null,
      },
      raceResult,
    };
  }

  if (winnerNorm !== trackedSelection && position == null) {
    return familyMatch ? { kind: 'settled-row', row: familyMatch, raceResult } : null;
  }

  const result = trackedType === 'ew'
    ? ((position === 1) ? 'ew_win' : (Number.isFinite(position) && position <= 3 ? 'ew_place' : 'ew_loss'))
    : (winnerNorm === trackedSelection ? 'win' : 'loss');

  return {
    kind: 'race-result',
    row: {
      meeting: trackedBet.meeting,
      race: trackedBet.race,
      selection: trackedBet.selection,
      type: trackedType,
      result,
      position,
      winner: raceResult.winner || trackedBet.selection,
      settled_at: raceResult.settledAt || null,
    },
    raceResult,
  };
}

function matchSettledBet(trackedBet, settledRows, raceResultIndex = null) {
  const source = buildTrackedSettlementSource(trackedBet, settledRows, raceResultIndex);
  return source?.row || null;
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
  const odds = toFiniteNumber(fallback.entryOdds ?? fallback.odds ?? row.odds);
  const rawPayout = toFiniteNumber(row.payout ?? row.return_units);
  const rawProfit = toFiniteNumber(row.profit ?? row.profit_units);
  const shouldIgnoreSourceReturns = result === 'won' && Number.isFinite(trackedStake) && Number.isFinite(odds) && (
    (Number.isFinite(rawPayout) && rawPayout <= 0)
    || (Number.isFinite(rawProfit) && rawProfit < 0)
  );
  const scaledPayout = shouldIgnoreSourceReturns ? null : scaleSettlementValue(rawPayout, trackedStake, unitStake);
  const scaledProfit = shouldIgnoreSourceReturns ? null : scaleSettlementValue(rawProfit, trackedStake, unitStake);
  const rawResult = String(row.result || fallback.result || '').trim().toLowerCase();
  const hasExplicitWinReturn = ['win', 'won', 'ew_win'].includes(rawResult);

  let payout = scaledPayout;
  let profit = scaledProfit;

  if (!Number.isFinite(payout) && result === 'won' && hasExplicitWinReturn && Number.isFinite(trackedStake) && Number.isFinite(odds)) {
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

  const sourceRoi = shouldIgnoreSourceReturns ? null : toFiniteNumber(row.roi ?? fallback.roi);
  const roi = sourceRoi
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

function toSettledResult(result) {
  const canonical = canonicalTrackedResult(result);
  if (canonical === 'won') return 'win';
  if (canonical === 'lost') return 'loss';
  return canonical;
}

function resolveTrackedBet(row = {}, settledRows = [], raceResultIndex = null) {
  const hit = matchSettledBet(row, settledRows, raceResultIndex);
  if (!hit) return row;
  const settlement = buildTrackedSettlement(hit, row);
  return {
    ...row,
    status: settlement.status,
    result: settlement.result,
    settledAt: settlement.settledAt,
    payout: settlement.payout,
    profit: settlement.profit,
    roi: settlement.roi,
    position: settlement.position,
    winner: settlement.winner,
  };
}

function resolveTrackedBets(rows = [], settledRows = [], raceResultIndex = null) {
  const raceMap = raceResultIndex instanceof Map ? raceResultIndex : buildRaceResultIndex(settledRows);
  return (Array.isArray(rows) ? rows : []).map((row) => resolveTrackedBet(row, settledRows, raceMap));
}

function buildTrackedSettledBetRow(trackedRow = {}, settledRow = {}) {
  const settlement = buildTrackedSettlement(settledRow, trackedRow);
  if (settlement.status !== 'settled') return null;
  const settledAt = settlement.settledAt || trackedRow.settledAt || trackedRow.trackedAt || null;
  return {
    id: trackedRow.id || null,
    source: 'tracked',
    date: settledAt ? String(settledAt).slice(0, 10) : null,
    settled_at: settledAt,
    meeting: trackedRow.meeting || settledRow.meeting || null,
    race: String(trackedRow.race || settledRow.race || '').replace(/^R/i, ''),
    selection: trackedRow.selection || settledRow.selection || null,
    type: normalizeBetType(trackedRow.betType || trackedRow.type || settledRow.type),
    result: toSettledResult(settlement.result),
    position: settlement.position,
    winner: settlement.winner,
    odds: toFiniteNumber(trackedRow.entryOdds ?? trackedRow.odds ?? settledRow.odds),
    place_odds: toFiniteNumber(settledRow.place_odds ?? settledRow.placeOdds),
    stake_units: toFiniteNumber(trackedRow.stake ?? trackedRow.stake_units),
    return_units: settlement.payout,
    profit_units: settlement.profit,
    roi: settlement.roi,
    tracked_at: trackedRow.trackedAt || null,
    betType: trackedRow.betType || trackedRow.type || null,
  };
}

function normalizeUserKey(value) {
  const raw = String(value || '').trim();
  return raw.includes('@') ? raw.toLowerCase() : raw;
}

function buildVisibleSettledRows(principal = {}, trackedRows = [], settledRows = [], raceResultIndex = null) {
  const username = normalizeUserKey(principal.username || '');
  const privateTenantScope = !principal?.isAdmin && String(principal?.effectiveTenantId || principal?.tenantId || 'default') !== 'default';
  const raceMap = raceResultIndex instanceof Map ? raceResultIndex : buildRaceResultIndex(settledRows);
  const visibleTrackedRows = privateTenantScope
    ? (Array.isArray(trackedRows) ? trackedRows : [])
    : (Array.isArray(trackedRows) ? trackedRows : []).filter((row) => normalizeUserKey(row.username || '') === username);
  const trackedSettledRows = visibleTrackedRows
    .map((row) => {
      const hit = matchSettledBet(row, settledRows, raceMap);
      return hit ? buildTrackedSettledBetRow(row, hit) : null;
    })
    .filter(Boolean);

  const directSettledRows = (Array.isArray(settledRows) ? settledRows : []).filter((row) => {
    if (principal?.isAdmin) return true;
    const rowUser = normalizeUserKey(row.username || row.user || row.userId || row.owner || '');
    if (rowUser) return rowUser === username;
    return privateTenantScope;
  });

  const seen = new Set();
  return [...trackedSettledRows, ...directSettledRows]
    .filter((row) => {
      const key = row.id
        ? `id:${row.id}`
        : buildSettledBetKey({
            meeting: row.meeting,
            race: row.race,
            selection: row.selection,
            type: row.type || row.betType,
          });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.settled_at || b.date || '').localeCompare(String(a.settled_at || a.date || '')));
}

function buildTrackedHistoryRows(principal = {}, trackedRows = [], settledRows = [], raceResultIndex = null) {
  const visibleSettledRows = buildVisibleSettledRows(principal, trackedRows, settledRows, raceResultIndex);
  const trackedKeys = new Set((Array.isArray(trackedRows) ? trackedRows : []).map((row) => buildSettledBetKey({
    meeting: row.meeting,
    race: row.race,
    selection: row.selection,
    type: row.betType || row.type,
  })));

  return visibleSettledRows
    .filter((row) => !trackedKeys.has(buildSettledBetKey(row)))
    .map((row) => ({
      id: `history:${buildSettledBetKey(row)}`,
      username: principal?.username || null,
      meeting: row.meeting || null,
      race: String(row.race || '').replace(/^R/i, ''),
      selection: row.selection || null,
      betType: normalizeBetType(row.type || row.betType),
      odds: toFiniteNumber(row.odds),
      entryOdds: toFiniteNumber(row.odds),
      stake: toFiniteNumber(row.stake_units),
      trackedAt: row.tracked_at || row.settled_at || row.date || null,
      status: 'settled',
      result: canonicalTrackedResult(row.result),
      settledAt: row.settled_at || row.date || null,
      payout: toFiniteNumber(row.return_units),
      profit: toFiniteNumber(row.profit_units),
      roi: toFiniteNumber(row.roi),
      position: row.position ?? null,
      winner: row.winner ?? null,
      source: row.source || 'history',
    }));
}

module.exports = {
  normalizeText,
  normalizeMeeting,
  normalizeRace,
  normalizeSelection,
  normalizeBetType,
  betTypeFamily,
  buildComparableBet,
  buildRaceResultIndex,
  buildTrackedSettlementSource,
  matchSettledBet,
  buildSettledBetKey,
  canonicalTrackedResult,
  buildTrackedSettlement,
  resolveTrackedBet,
  resolveTrackedBets,
  buildTrackedSettledBetRow,
  buildVisibleSettledRows,
  buildTrackedHistoryRows,
};
