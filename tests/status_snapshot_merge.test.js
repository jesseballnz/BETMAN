#!/usr/bin/env node
const assert = require('assert');
const { mergePublicStatusLists } = require('../scripts/status_snapshot_merge');

const globalStatus = {
  updatedAt: '2026-03-24T00:00:00.000Z',
  balance: 123.45,
  suggestedBets: [
    { meeting: 'Port Macquarie', race: '1', selection: 'Farnciful', type: 'Win', reason: 'global-a' },
    { meeting: 'Yarra Valley', race: '2', selection: "I'm Foxing", type: 'Win', reason: 'global-b' }
  ],
  interestingRunners: [
    { meeting: 'Port Macquarie', race: '1', runner: 'Colorado Tycoon', reason: 'watchlist' }
  ],
  marketMovers: [
    { meeting: 'Port Macquarie', race: '1', runner: 'Farnciful', fromOdds: 2.4, toOdds: 2.2 }
  ],
  nextPlans: [
    { meeting: 'Port Macquarie', race: '1', selection: 'Farnciful', type: 'Win', state: 'queued' }
  ],
  betPlans: [
    { meeting: 'Port Macquarie', race: '1', selection: 'Farnciful', type: 'Win' }
  ]
};

const emptyTenant = {
  suggestedBets: []
};

const mergedEmptyTenant = mergePublicStatusLists(globalStatus, emptyTenant);
assert.strictEqual(mergedEmptyTenant.suggestedBets.length, 2, 'empty tenant should inherit global suggested bets');
assert.strictEqual(mergedEmptyTenant.interestingRunners.length, 1, 'empty tenant should inherit global interesting runners');
assert.strictEqual(mergedEmptyTenant.marketMovers.length, 1, 'empty tenant should inherit global market movers');
assert.strictEqual(mergedEmptyTenant.nextPlans.length, 1, 'empty tenant should inherit global next plans');
assert.strictEqual(mergedEmptyTenant.betPlans.length, 1, 'empty tenant should inherit global bet plans');
assert.strictEqual(mergedEmptyTenant.balance, undefined, 'scalar account fields must not leak from global snapshot');

const tenantOverride = {
  suggestedBets: [
    { meeting: 'Port Macquarie', race: '1', selection: 'Farnciful', type: 'Win', reason: 'tenant-override' },
    { meeting: 'Rosehill', race: '5', selection: 'New Runner', type: 'EW', reason: 'tenant-new' }
  ],
  marketMovers: [
    { meeting: 'Port Macquarie', race: '1', runner: 'Farnciful', fromOdds: 2.5, toOdds: 2.1 },
    { meeting: 'Rosehill', race: '5', runner: 'New Runner', fromOdds: 8.0, toOdds: 7.0 }
  ],
  interestingRunners: [
    { meeting: 'Rosehill', race: '5', runner: 'New Runner', reason: 'tenant-watch' }
  ],
  nextPlans: [
    { meeting: 'Port Macquarie', race: '1', selection: 'Farnciful', type: 'Win', state: 'placed' }
  ],
  betPlans: [
    { meeting: 'Rosehill', race: '5', selection: 'New Runner', type: 'EW' }
  ],
  updatedAt: 'tenant-ts',
  balance: 9.87
};

const mergedOverride = mergePublicStatusLists(globalStatus, tenantOverride);
assert.strictEqual(mergedOverride.suggestedBets.length, 3, 'tenant snapshot should override duplicate signal and append unique rows');
assert.strictEqual(
  mergedOverride.suggestedBets.find(row => row.meeting === 'Port Macquarie' && row.race === '1' && row.selection === 'Farnciful' && row.type === 'Win').reason,
  'tenant-override',
  'tenant duplicate signal should override global row'
);
assert.strictEqual(mergedOverride.marketMovers.length, 2, 'tenant movers should override duplicate and keep unique rows');
assert.strictEqual(
  mergedOverride.marketMovers.find(row => row.meeting === 'Port Macquarie' && row.race === '1' && row.runner === 'Farnciful').toOdds,
  2.1,
  'tenant market mover should override global row'
);
assert.strictEqual(mergedOverride.interestingRunners.length, 2, 'interesting runners should merge across global and tenant');
assert.strictEqual(mergedOverride.nextPlans.length, 2, 'state-aware next plans should keep distinct states');
assert.strictEqual(mergedOverride.betPlans.length, 2, 'bet plans should merge across global and tenant');
assert.strictEqual(mergedOverride.balance, 9.87, 'tenant scalar account fields should be preserved');
assert.strictEqual(mergedOverride.updatedAt, 'tenant-ts', 'tenant metadata should be preserved');

console.log('status_snapshot_merge tests passed');
