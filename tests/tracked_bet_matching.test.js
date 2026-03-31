#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeSelection,
  normalizeBetType,
  matchSettledBet,
  buildSettledBetKey,
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

console.log('tracked_bet_matching.test.js: ok');
