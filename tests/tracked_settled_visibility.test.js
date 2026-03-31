#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildVisibleSettledRows,
} = require('../scripts/tracked_bet_matching');

const principal = {
  username: 'test@betman.co.nz',
  tenantId: 'acct_test-betman-co-nz',
  effectiveTenantId: 'acct_test-betman-co-nz',
  isAdmin: false,
};

const settledRows = [
  {
    date: '2026-03-26',
    meeting: 'Cairns',
    race: '1',
    selection: 'Kammerzell House',
    type: 'win',
    result: 'win',
    position: 1,
    winner: 'Kammerzell House',
    odds: 1.9,
    stake_units: 1,
    return_units: 1.9,
    profit_units: 0.9,
    roi: 0.9,
  },
  {
    date: '2026-03-27',
    meeting: 'Cairns',
    race: '2',
    selection: 'Named User Row',
    type: 'win',
    result: 'loss',
    username: 'test@betman.co.nz',
  },
];

const visible = buildVisibleSettledRows(principal, [], settledRows);
assert.strictEqual(visible.length, 2, 'private-tenant settled view should include tenant-settled rows without usernames');
assert.strictEqual(visible.some((row) => row.selection === 'Kammerzell House'), true);
assert.strictEqual(visible.some((row) => row.selection === 'Named User Row'), true);

console.log('tracked_settled_visibility.test.js: ok');
