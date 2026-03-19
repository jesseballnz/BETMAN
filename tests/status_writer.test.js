const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tmpDir = path.join(__dirname, 'tmp');
const statePath = path.join(tmpDir, 'racing-poll-state.json');
const balancePath = path.join(tmpDir, 'balance.json');
const outPath = path.join(tmpDir, 'status.json');

fs.mkdirSync(tmpDir, { recursive: true });

// Minimal poll state
const state = {
  ts: '2026-02-28T10:00:00.000Z',
  races: {
    'AUS:Toowoomba:R5': {
      meeting: 'Toowoomba',
      race_number: 5,
      description: 'Race 5',
      start_time_nz: '22:30:00 NZDT',
      race_status: 'Open'
    }
  },
  bet_plans: [
    { race: 'AUS:Toowoomba:R5', selection: 'Horse A', stake: 10, bet_type: 'Win', odds: 5.0, mins_to_start: 9 }
  ]
};

const balance = {
  betcha: { balance: 58.41, openBets: 1 },
  tab: { balance: 12.5, openBets: 2 }
};

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.writeFileSync(balancePath, JSON.stringify(balance, null, 2));

// Run status_writer by requiring and faking paths
const statusWriter = require('../scripts/status_writer_impl');
const result = statusWriter.buildStatus(state, balance);

assert.strictEqual(result.openBets, 3);
assert.strictEqual(result.balance, 70.91); // Betcha + TAB
assert.strictEqual(result.upcomingRaces.length, 1);
assert.strictEqual(result.upcomingBets.length, 1);
assert.ok(result.activity[0].includes('Poller updated'));
assert.ok(result.activity[1].includes('Bet plans ready now') || result.activity[1].includes('Early queue plans') || result.activity[1].includes('No bet plans'));

// Write output to ensure no throw
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log('status_writer tests passed');
