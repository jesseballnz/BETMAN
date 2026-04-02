const assert = require('assert');
const { aggregateLastNDays, normalizeLedgerResult, summarizeSettledBets, groupSettledBetsByDate } = require('../frontend/perf-utils');

const sampleDaily = {
  '2026-03-16': {
    total_bets: 10,
    total_stake: 10,
    roi_stake: 10,
    win_bets: 10,
    wins: 3,
    win_rate: 0.3,
    roi_rec: 0.1,
    pick_breakdown: {
      win: { bets: 4, stake_units: 4, roi_stake_units: 4, profit_rec: 0.4, wins: 2 },
      odds_runner: { bets: 4, stake_units: 4, roi_stake_units: 4, profit_rec: -0.4, wins: 1 },
      ew: { bets: 2, stake_units: 2, roi_stake_units: 2, profit_rec: 0, wins: 0 }
    },
    long_breakdown: { bets: 2, stake_units: 2, roi_stake_units: 2, profit_rec: -0.2, wins: 0 }
  },
  '2026-03-17': {
    total_bets: 12,
    total_stake: 12,
    roi_stake: 12,
    win_bets: 12,
    wins: 5,
    win_rate: 0.4166666667,
    roi_rec: -0.05,
    pick_breakdown: {
      win: { bets: 5, stake_units: 5, roi_stake_units: 5, profit_rec: 0.25, wins: 3 },
      odds_runner: { bets: 4, stake_units: 4, roi_stake_units: 4, profit_rec: -0.5, wins: 1 },
      ew: { bets: 3, stake_units: 3, roi_stake_units: 3, profit_rec: 0.1, wins: 1 }
    },
    long_breakdown: { bets: 1, stake_units: 1, roi_stake_units: 1, profit_rec: 0.3, wins: 1 }
  }
};

const agg = aggregateLastNDays(sampleDaily, 30);

assert.strictEqual(agg.win_bets, 22, 'should sum win bets');
assert.strictEqual(agg.wins, 8, 'should sum integer wins (not fractional)');
assert.strictEqual(agg.pick.win.wins, 5);
assert.strictEqual(agg.pick.odds_runner.wins, 2);
assert.strictEqual(agg.pick.ew.wins, 1);
assert.strictEqual(agg.long.wins, 1);

assert.strictEqual(normalizeLedgerResult('won'), 'win');
assert.strictEqual(normalizeLedgerResult('placed'), 'ew_place');

const settledRows = [
  { date: '2026-03-17', meeting: 'Ellerslie', race: '2', selection: 'Alpha', result: 'win', stake_units: 1, return_units: 2.8, profit_units: 1.8 },
  { date: '2026-03-17', meeting: 'Ellerslie', race: '5', selection: 'Bravo', result: 'loss', stake_units: 1, return_units: 0, profit_units: -1 },
  { date: '2026-03-16', meeting: 'Pukekohe', race: '1', selection: 'Charlie', result: 'ew_place', stake_units: 2, return_units: 3.2, profit_units: 1.2 }
];

const settledSummary = summarizeSettledBets(settledRows);
assert.deepStrictEqual(settledSummary, {
  bets: 3,
  stake: 4,
  returnUnits: 6,
  profitUnits: 2,
  hits: 2,
});

const ledgerDays = groupSettledBetsByDate(settledRows);
assert.strictEqual(ledgerDays.length, 2);
assert.strictEqual(ledgerDays[0].date, '2026-03-17');
assert.strictEqual(ledgerDays[0].summary.bets, 2);
assert.strictEqual(ledgerDays[0].summary.profitUnits, 0.8);
assert.strictEqual(ledgerDays[1].date, '2026-03-16');
assert.strictEqual(ledgerDays[1].summary.hits, 1);

console.log('perf-utils tests passed');
