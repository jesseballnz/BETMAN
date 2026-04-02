const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmpDir = path.join(__dirname, 'tmp', 'tracked_mode_transition_alerts');
const tenantId = 'test_tracked_mode_transition_alerts';
const statePath = path.join(tmpDir, 'state.json');
const statusPath = path.join(tmpDir, 'status.json');
const tenantDir = path.join(root, 'memory', 'tenants', tenantId, 'frontend-data');
const alertsPath = path.join(tenantDir, 'alerts_feed.json');
const historyPath = path.join(tenantDir, 'alerts_history.json');
const trackedBetsPath = path.join(tenantDir, 'tracked_bets.json');
const pulseConfigPath = path.join(tenantDir, 'pulse_config.json');

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(tenantDir, { recursive: true });

const state = {
  ts: new Date().toISOString(),
  races: {
    'NZ:Ashburton:R3': {
      country: 'NZ',
      meeting: 'Ashburton',
      race_number: 3,
      race_status: 'Open',
      advertised_start: new Date(Date.now() + (30 * 60 * 1000)).toISOString(),
      runners: [
        { runner_name: 'Conviction Horse', fixed_win: 4.8 },
      ],
    },
  },
  bet_plans: [],
  candidates: [],
  next_races: [],
};

const previousStatus = {
  suggestedBets: [],
  interestingRunners: [],
  marketOddsSnapshot: {
    'NZ:Ashburton:R3|conviction horse': 4.8,
  },
  marketOddsHistory: {
    'NZ:Ashburton:R3|conviction horse': [{ ts: Date.now() - 10 * 60 * 1000, odds: 4.8 }],
  },
  marketOddsOpening: {
    'NZ:Ashburton:R3|conviction horse': 4.8,
  },
};

function runWriter() {
  execFileSync('node', [path.join(root, 'scripts', 'status_writer.js'), `--state_path=${statePath}`, `--status_path=${statusPath}`], {
    cwd: root,
    env: { ...process.env, TENANT_ID: tenantId },
    stdio: 'pipe',
  });
}

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.writeFileSync(statusPath, JSON.stringify(previousStatus, null, 2));
fs.writeFileSync(alertsPath, JSON.stringify({ updatedAt: null, alerts: [] }, null, 2));
fs.writeFileSync(historyPath, JSON.stringify([], null, 2));
fs.writeFileSync(pulseConfigPath, JSON.stringify({
  enabled: true,
  alertTypes: {
    plunges: true,
    drifts: true,
    conflicts: true,
    selectionFlips: true,
    preJumpHeat: true,
    jumpPulse: true,
  },
  thresholds: {
    minSeverity: 'HOT',
    maxMinsToJump: null,
    minMovePct: null,
    trackedRunnerOverride: true,
  },
}, null, 2));

fs.writeFileSync(trackedBetsPath, JSON.stringify([
  { id: 'tracked-1', meeting: 'Ashburton', race: '3', selection: 'Conviction Horse', betType: 'Watch', status: 'active' },
], null, 2));
runWriter();

let alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
assert(!alertsFeed.alerts.some((a) => a.type === 'tracked_upgrade' || a.type === 'tracked_downgrade'), 'first snapshot should only seed tracked mode state');

fs.writeFileSync(trackedBetsPath, JSON.stringify([
  { id: 'tracked-1', meeting: 'Ashburton', race: '3', selection: 'Conviction Horse', betType: 'Win', status: 'active', priorityRank: 3 },
], null, 2));
runWriter();

alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
const upgrade = alertsFeed.alerts.find((a) => a.type === 'tracked_upgrade' && a.selection === 'Conviction Horse');
assert(upgrade, 'expected tracked upgrade alert after Watch → Win transition');
assert.strictEqual(upgrade.previousBetType, 'Watch');
assert.strictEqual(upgrade.nextBetType, 'Win');
assert.strictEqual(upgrade.modeTransition?.ordering, 'watch < odds_runner < ew < win');
assert(['HOT', 'CRITICAL'].includes(upgrade.severity), 'upgrade should surface above WATCH');

fs.writeFileSync(trackedBetsPath, JSON.stringify([
  { id: 'tracked-1', meeting: 'Ashburton', race: '3', selection: 'Conviction Horse', betType: 'Watch', status: 'active', priorityRank: 3 },
], null, 2));
runWriter();

alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
const downgrade = alertsFeed.alerts.find((a) => a.type === 'tracked_downgrade' && a.selection === 'Conviction Horse');
assert(downgrade, 'expected tracked downgrade alert after Win → Watch transition');
assert.strictEqual(downgrade.previousBetType, 'Win');
assert.strictEqual(downgrade.nextBetType, 'Watch');
assert(['HOT', 'CRITICAL'].includes(downgrade.severity), 'downgrade should surface above WATCH');

const finalStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
assert.strictEqual(finalStatus.trackedRunnerModes['ashburton|3|conviction horse'].normalizedBetType, 'watch');

const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
assert(history.some((a) => a.type === 'tracked_upgrade' && a.selection === 'Conviction Horse'), 'upgrade should persist to Pulse history');
assert(history.some((a) => a.type === 'tracked_downgrade' && a.selection === 'Conviction Horse'), 'downgrade should persist to Pulse history');

console.log('tracked_mode_transition_alerts.test.js: ok');
