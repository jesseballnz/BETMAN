#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildTrackedHistoryRows } = require('../scripts/tracked_bet_matching');

const principal = {
  username: 'test@betman.co.nz',
  tenantId: 'acct_test-betman-co-nz',
  effectiveTenantId: 'acct_test-betman-co-nz',
  isAdmin: false,
};

const rows = buildTrackedHistoryRows(principal, [], [
  {
    date: '2026-03-26',
    settled_at: '2026-03-26T02:00:00.000Z',
    meeting: 'Cairns',
    race: '1',
    selection: 'Kammerzell House',
    type: 'win',
    result: 'win',
    odds: 1.9,
    stake_units: 1,
    return_units: 1.9,
    profit_units: 0.9,
    roi: 0.9,
    winner: 'Kammerzell House',
    position: 1,
  },
], null);

assert.strictEqual(rows.length, 1, 'should synthesize tracked history rows from visible settled rows');
assert.deepStrictEqual(
  {
    meeting: rows[0].meeting,
    race: rows[0].race,
    selection: rows[0].selection,
    betType: rows[0].betType,
    status: rows[0].status,
    result: rows[0].result,
  },
  {
    meeting: 'Cairns',
    race: '1',
    selection: 'Kammerzell House',
    betType: 'win',
    status: 'settled',
    result: 'won',
  }
);

const deduped = buildTrackedHistoryRows(principal, [
  {
    id: 'tracked-1',
    meeting: 'Cairns',
    race: '1',
    selection: 'Kammerzell House',
    betType: 'Win',
    trackedAt: '2026-03-26T01:00:00.000Z',
    status: 'settled',
  },
], [
  {
    date: '2026-03-26',
    settled_at: '2026-03-26T02:00:00.000Z',
    meeting: 'Cairns',
    race: '1',
    selection: 'Kammerzell House',
    type: 'win',
    result: 'win',
  },
], null);

assert.strictEqual(deduped.length, 0, 'should not duplicate rows already present in tracked history');

console.log('tracked_history_recovery.test.js: ok');
