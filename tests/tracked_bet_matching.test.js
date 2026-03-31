#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeSelection,
  normalizeBetType,
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

const winnerFallback = matchSettledBet(
  { meeting: 'Newcastle', race: '1', selection: 'Cavalry', betType: 'Win' },
  [
    { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry' },
    { meeting: 'Newcastle', race: '1', selection: 'Dubliners', type: 'odds_runner', result: 'loss', position: 8, winner: 'Cavalry' },
  ]
);
assert.strictEqual(winnerFallback && winnerFallback.selection, 'Cavalry');
assert.strictEqual(winnerFallback && winnerFallback.result, 'win');
assert.strictEqual(winnerFallback && winnerFallback.position, 1);

const raceIndex = buildRaceResultIndex([
  { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
  { meeting: 'Newcastle', race: '1', selection: 'Dubliners', type: 'odds_runner', result: 'loss', position: 8, winner: 'Cavalry' },
]);
assert.strictEqual(raceIndex.get('newcastle|1').winner, 'Cavalry');
assert.strictEqual(raceIndex.get('newcastle|1').positions.get('sarapo'), 3);

const raceFirstSource = buildTrackedSettlementSource(
  { meeting: 'Newcastle', race: '1', selection: 'Cavalry', betType: 'Win', entryOdds: 3.3, stake: 5 },
  [
    { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
    { meeting: 'Newcastle', race: '1', selection: 'Dubliners', type: 'odds_runner', result: 'loss', position: 8, winner: 'Cavalry' },
  ],
  raceIndex,
);
assert.strictEqual(raceFirstSource && raceFirstSource.kind, 'race-result');
assert.strictEqual(raceFirstSource && raceFirstSource.row && raceFirstSource.row.result, 'win');
assert.strictEqual(raceFirstSource && raceFirstSource.row && raceFirstSource.row.position, 1);

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

assert.deepStrictEqual(
  buildTrackedSettlement(
    { result: 'win', return_units: 1.7, profit_units: 0.7, stake_units: 1 },
    { stake: 10, entryOdds: 1.7, settledAt: '2026-03-31T01:00:00.000Z' },
  ),
  {
    status: 'settled',
    result: 'won',
    settledAt: '2026-03-31T01:00:00.000Z',
    payout: 17,
    profit: 7,
    roi: 0.7,
    position: null,
    winner: null,
  }
);

assert.deepStrictEqual(
  buildTrackedSettlement(
    { result: 'loss', stake_units: 1 },
    { stake: 10, entryOdds: 3.2, settledAt: '2026-03-31T02:00:00.000Z' },
  ),
  {
    status: 'settled',
    result: 'lost',
    settledAt: '2026-03-31T02:00:00.000Z',
    payout: 0,
    profit: -10,
    roi: -1,
    position: null,
    winner: null,
  }
);

assert.deepStrictEqual(
  resolveTrackedBet(
    {
      id: 'tracked-win',
      meeting: 'Newcastle',
      race: '1',
      selection: 'Cavalry',
      betType: 'Win',
      stake: 5,
      entryOdds: 3.3,
      status: 'active',
      result: 'pending',
    },
    [
      { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
      { meeting: 'Newcastle', race: '1', selection: 'Dubliners', type: 'odds_runner', result: 'loss', position: 8, winner: 'Cavalry' },
    ],
    raceIndex,
  ),
  {
    id: 'tracked-win',
    meeting: 'Newcastle',
    race: '1',
    selection: 'Cavalry',
    betType: 'Win',
    stake: 5,
    entryOdds: 3.3,
    status: 'settled',
    result: 'won',
    settledAt: '2026-03-31T04:05:06.000Z',
    payout: 16.5,
    profit: 11.5,
    roi: 2.3,
    position: 1,
    winner: 'Cavalry',
  }
);

assert.deepStrictEqual(
  resolveTrackedBet(
    {
      id: 'tracked-loss',
      meeting: 'Newcastle',
      race: '1',
      selection: 'Sarapo',
      betType: 'Win',
      stake: 5,
      entryOdds: 3.3,
      status: 'active',
      result: 'pending',
    },
    [
      { meeting: 'Newcastle', race: '1', selection: 'Cavalry', type: 'win', result: 'win', position: 1, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
      { meeting: 'Newcastle', race: '1', selection: 'Dubliners', type: 'odds_runner', result: 'loss', position: 8, winner: 'Cavalry' },
    ]
  ),
  {
    id: 'tracked-loss',
    meeting: 'Newcastle',
    race: '1',
    selection: 'Sarapo',
    betType: 'Win',
    stake: 5,
    entryOdds: 3.3,
    status: 'active',
    result: 'pending',
  },
  'no direct row and no tracked position should stay unresolved'
);

assert.deepStrictEqual(
  resolveTrackedBet(
    {
      id: 'tracked-ew',
      meeting: 'Newcastle',
      race: '1',
      selection: 'Sarapo',
      betType: 'EW',
      stake: 5,
      entryOdds: 8,
      status: 'active',
      result: 'pending',
    },
    [
      { meeting: 'Newcastle', race: '1', selection: 'Cavalry', type: 'win', result: 'win', position: 1, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
      { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry' },
    ]
  ),
  {
    id: 'tracked-ew',
    meeting: 'Newcastle',
    race: '1',
    selection: 'Sarapo',
    betType: 'EW',
    stake: 5,
    entryOdds: 8,
    status: 'settled',
    result: 'won',
    settledAt: '2026-03-31T04:05:06.000Z',
    payout: null,
    profit: null,
    roi: null,
    position: 3,
    winner: 'Cavalry',
  }
);

assert.deepStrictEqual(
  resolveTrackedBets(
    [
      { id: 'tracked-win', meeting: 'Newcastle', race: '1', selection: 'Cavalry', betType: 'Win', stake: 5, entryOdds: 3.3, status: 'active', result: 'pending' },
      { id: 'tracked-missing', meeting: 'Newcastle', race: '2', selection: 'Unknown', betType: 'Win', stake: 5, entryOdds: 2.2, status: 'active', result: 'pending' },
    ],
    [
      { meeting: 'Newcastle', race: '1', selection: 'Sarapo', type: 'win', result: 'loss', position: 3, winner: 'Cavalry', settled_at: '2026-03-31T04:05:06.000Z' },
    ],
    raceIndex,
  ).map((row) => ({ id: row.id, status: row.status, result: row.result, winner: row.winner || null })),
  [
    { id: 'tracked-win', status: 'settled', result: 'won', winner: 'Cavalry' },
    { id: 'tracked-missing', status: 'active', result: 'pending', winner: null },
  ]
);

assert.deepStrictEqual(
  buildTrackedSettledBetRow(
    {
      id: 'tracked-1',
      meeting: 'Newcastle',
      race: 'R1',
      selection: 'Cavalry',
      betType: 'Win',
      entryOdds: 3.3,
      stake: 5,
      trackedAt: '2026-03-31T03:00:00.000Z',
    },
    {
      meeting: 'Newcastle',
      race: '1',
      selection: '7. Cavalry',
      type: 'win',
      result: 'win',
      settled_at: '2026-03-31T04:05:06.000Z',
      odds: 3.3,
      stake_units: 1,
      return_units: 3.3,
      profit_units: 2.3,
      roi: 2.3,
      winner: 'Cavalry',
      position: 1,
    }
  ),
  {
    id: 'tracked-1',
    source: 'tracked',
    date: '2026-03-31',
    settled_at: '2026-03-31T04:05:06.000Z',
    meeting: 'Newcastle',
    race: '1',
    selection: 'Cavalry',
    type: 'win',
    result: 'win',
    position: 1,
    winner: 'Cavalry',
    odds: 3.3,
    place_odds: null,
    stake_units: 5,
    return_units: 16.5,
    profit_units: 11.5,
    roi: 2.3,
    tracked_at: '2026-03-31T03:00:00.000Z',
    betType: 'Win',
  }
);

assert.deepStrictEqual(
  buildVisibleSettledRows(
    { username: 'user@example.com', isAdmin: false },
    [
      {
        id: 'tracked-1',
        username: 'user@example.com',
        meeting: 'Newcastle',
        race: '1',
        selection: 'Cavalry',
        betType: 'Win',
        entryOdds: 3.3,
        stake: 5,
        trackedAt: '2026-03-31T03:00:00.000Z',
      },
      {
        id: 'tracked-2',
        username: 'other@example.com',
        meeting: 'Newcastle',
        race: '1',
        selection: 'Other',
        betType: 'Win',
        entryOdds: 4,
        stake: 5,
        trackedAt: '2026-03-31T03:00:00.000Z',
      },
    ],
    [
      {
        meeting: 'Newcastle',
        race: '1',
        selection: 'Cavalry',
        type: 'win',
        result: 'win',
        settled_at: '2026-03-31T04:05:06.000Z',
        odds: 3.3,
        stake_units: 1,
        return_units: 3.3,
        profit_units: 2.3,
        roi: 2.3,
        winner: 'Cavalry',
        position: 1,
      },
      {
        meeting: 'Auckland',
        race: '2',
        selection: 'Leaked Global Row',
        type: 'win',
        result: 'loss',
        settled_at: '2026-03-31T05:00:00.000Z',
        odds: 2,
        stake_units: 1,
        return_units: 0,
        profit_units: -1,
        roi: -1,
      },
      {
        meeting: 'Wellington',
        race: '3',
        selection: 'Direct User Row',
        type: 'win',
        result: 'win',
        settled_at: '2026-03-31T06:00:00.000Z',
        odds: 2.5,
        stake_units: 1,
        return_units: 2.5,
        profit_units: 1.5,
        roi: 1.5,
        username: 'user@example.com',
      },
    ]
  ).map((row) => row.selection),
  ['Direct User Row', 'Cavalry']
);

assert.deepStrictEqual(
  buildVisibleSettledRows(
    { username: 'admin', isAdmin: true },
    [],
    [
      {
        meeting: 'Auckland',
        race: '2',
        selection: 'Global Row',
        type: 'win',
        result: 'loss',
        settled_at: '2026-03-31T05:00:00.000Z',
        odds: 2,
        stake_units: 1,
        return_units: 0,
        profit_units: -1,
        roi: -1,
      },
    ]
  ).map((row) => row.selection),
  ['Global Row']
);

console.log('tracked_bet_matching.test.js: ok');
