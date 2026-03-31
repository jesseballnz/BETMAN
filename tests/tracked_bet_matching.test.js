#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeSelection,
  normalizeBetType,
  matchSettledBet,
  buildSettledBetKey,
  canonicalTrackedResult,
  buildTrackedSettlement,
} = require('../scripts/tracked_bet_matching');

assert.strictEqual(normalizeSelection('7. Cavalry'), 'cavalry');
assert.strictEqual(normalizeSelection('(7) Cavalry'), 'cavalry');
assert.strictEqual(normalizeSelection('Emergency 2 - Cavalry'), 'cavalry');
assert.strictEqual(normalizeBetType('Each Way'), 'ew');
assert.strictEqual(normalizeBetType('Odds Runner'), 'odds_runner');
assert.strictEqual(normalizeBetType('Win'), 'win');

const exact = matchSettledBet(
  { meeting: 'Newcastle', race: '1', selection: 'Cavalry', betType: 'Win' },
  [
    { meeting: 'Newcastle', race: 'R1', selection: '7. Cavalry', type: 'ew', result: 'ew_place' },
    { meeting: 'Newcastle', race: '1', selection: 'Cavalry', type: 'win', result: 'win' },
  ]
);
assert.strictEqual(exact && exact.result, 'win');

const familyFallback = matchSettledBet(
  { meeting: 'Newcastle', race: '1', selection: '7. Cavalry', betType: 'Win' },
  [{ meeting: 'Newcastle', race: 'R1', selection: 'Cavalry', type: 'ew', result: 'ew_place' }]
);
assert.strictEqual(familyFallback && familyFallback.result, 'ew_place');

const oddsRunnerFallback = matchSettledBet(
  { meeting: 'Newcastle', race: '1', selection: 'Cavalry', betType: 'Win' },
  [{ meeting: 'Newcastle', race: '1', selection: 'Cavalry', type: 'odds_runner', result: 'loss' }]
);
assert.strictEqual(oddsRunnerFallback && oddsRunnerFallback.result, 'loss');

assert.strictEqual(
  buildSettledBetKey({ meeting: 'Newcastle', race: 'R1', selection: '7. Cavalry', type: 'Each Way' }),
  'newcastle|1|cavalry|ew'
);

assert.strictEqual(canonicalTrackedResult('win'), 'won');
assert.strictEqual(canonicalTrackedResult('loss'), 'lost');
assert.strictEqual(canonicalTrackedResult('ew_place'), 'won');
assert.strictEqual(canonicalTrackedResult('ew_loss'), 'lost');

assert.deepStrictEqual(
  buildTrackedSettlement({ result: 'win', return_units: 8.5, profit_units: 7.5 }, { settledAt: '2026-03-31T00:00:00.000Z' }),
  {
    status: 'settled',
    result: 'won',
    settledAt: '2026-03-31T00:00:00.000Z',
    payout: 8.5,
    profit: 7.5,
    roi: null,
    position: null,
    winner: null,
  }
);

console.log('tracked_bet_matching.test.js: ok');
