#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'status.json'), 'utf8'));
const racesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'races.json'), 'utf8'));
const races = Array.isArray(racesData.races) ? racesData.races : [];

const normalizeMeeting = (m) => String(m || '').trim().toLowerCase();
const lookupRace = (meeting, raceNo) => {
  const mn = normalizeMeeting(meeting);
  const rn = String(raceNo || '').replace(/^R/i,'').trim();
  return races.find(r => normalizeMeeting(r.meeting) === mn && String(r.race_number || '').trim() === rn) || null;
};

const parseReasonWinProb = (reason='') => {
  const m = String(reason || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return NaN;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : NaN;
};

const parseReasonOdds = (reason='') => {
  const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return NaN;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : NaN;
};

const extractRowOdds = (row={}) => {
  const odds = parseReasonOdds(row.reason);
  if (Number.isFinite(odds)) return odds;
  const direct = Number(row.odds || row.fixed_win || row.tote_win || 0);
  return Number.isFinite(direct) ? direct : NaN;
};

const rowFormSignal = (row={}) => {
  const raw = String(row.form_signal || row.form || '').toUpperCase();
  if (raw.includes('HOT')) return { status: 'HOT' };
  if (raw.includes('SOLID')) return { status: 'SOLID' };
  if (raw.includes('MIXED')) return { status: 'MIXED' };
  if (raw.includes('COLD')) return { status: 'COLD' };
  return null;
};

const rowMatchesLongProfile = (row={}) => {
  const odds = extractRowOdds(row);
  if (!Number.isFinite(odds) || odds < 8) return false;
  const signal = rowFormSignal(row);
  if (signal && (signal.status === 'HOT' || signal.status === 'SOLID')) return true;
  const race = lookupRace(row.meeting, row.race || row.race_number);
  const region = String(race?.country || row?.country || '').trim().toUpperCase();
  if (region === 'HK') return true;
  return false;
};

const rowHasValueEdge = (row={}) => {
  const winProb = parseReasonWinProb(row.reason);
  const odds = extractRowOdds(row);
  if (!Number.isFinite(winProb) || !Number.isFinite(odds) || odds <= 0) return false;
  const implied = 100 / odds;
  const edge = winProb - implied;
  return edge >= 1.5;
};

const signalScore = (reason='', type='', selection='') => {
  const p = parseReasonWinProb(reason);
  const odds = extractRowOdds({ reason, odds: null });
  if (!Number.isFinite(p) || !Number.isFinite(odds)) return NaN;
  const implied = 100 / odds;
  const edge = p - implied;
  const score = Math.max(0, Math.min(100, 50 + edge * 2));
  return score;
};

const filterSuggestedByWhy = (rows, why) => (rows || []).filter(r => {
  const reason = String(r.reason || '').toLowerCase();
  const type = String(r.type || '').toLowerCase();
  const p = parseReasonWinProb(reason);
  const odds = extractRowOdds(r);
  const stake = Number(r.stake || 0);
  const exotic = ['top2','top3','top4','trifecta','multi'].includes(type);
  if (why === 'STRONG') return !exotic && ((Number.isFinite(p) && p >= 24) || stake >= 0);
  if (why === 'VALUE') return !exotic && (type === 'ew' || (Number.isFinite(odds) && odds >= 5) || (Number.isFinite(p) && p < 20) || reason.includes('value') || reason.includes('long-odds'));
  if (why === 'LONG') return !exotic && rowMatchesLongProfile(r);
  if (why === 'EXOTIC') return exotic;
  return true;
});

const filterInterestingByWhy = (rows, why) => (rows || []).filter(r => {
  const odds = extractRowOdds(r);
  const signal = signalScore(String(r.reason || ''), String(r.type || 'win'), String(r.runner || r.selection || ''));
  if (why === 'STRONG') return (Number.isFinite(signal) && signal >= 65) || (Number.isFinite(odds) && odds > 0 && odds <= 3.6);
  if (why === 'VALUE') return Number.isFinite(odds) && odds >= 3 && odds <= 12 && rowHasValueEdge(r);
  if (why === 'LONG') return Number.isFinite(odds) && odds >= 8 && rowMatchesLongProfile(r);
  if (why === 'EXOTIC') return false;
  return true;
});

const filterMoversByWhy = (rows, why) => (rows || []).filter(r => {
  const odds = extractRowOdds(r);
  const move = Number(r.pctMove || r.change5m || r.change1m || 0);
  if (why === 'STRONG') return Number.isFinite(odds) && odds > 0 && odds <= 3.6;
  if (why === 'VALUE') return Number.isFinite(odds) && odds >= 3 && odds <= 12 && move <= -5;
  if (why === 'LONG') return Number.isFinite(odds) && odds >= 12;
  if (why === 'EXOTIC') return false;
  return true;
});

const whyList = ['ALL','STRONG','VALUE','LONG','EXOTIC'];
const buckets = [
  ['suggested', status.suggestedBets || [], filterSuggestedByWhy],
  ['interesting', status.interestingRunners || [], filterInterestingByWhy],
  ['movers', status.marketMovers || [], filterMoversByWhy]
];

for (const [label, rows, fn] of buckets) {
  console.log(`\n${label.toUpperCase()}: total ${rows.length}`);
  for (const why of whyList) {
    const filtered = fn(rows, why);
    console.log(`  ${why.padEnd(7)} -> ${filtered.length}`);
  }
}
