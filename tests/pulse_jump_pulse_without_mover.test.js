const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmpDir = path.join(__dirname, 'tmp', 'pulse_jump_pulse_without_mover');
const tenantId = 'test_pulse_jump_pulse_without_mover';
const statePath = path.join(tmpDir, 'state.json');
const statusPath = path.join(tmpDir, 'status.json');
const tenantDir = path.join(root, 'memory', 'tenants', tenantId, 'frontend-data');
const alertsPath = path.join(tenantDir, 'alerts_feed.json');
const historyPath = path.join(tenantDir, 'alerts_history.json');
const trackedBetsPath = path.join(tenantDir, 'tracked_bets.json');
const pulseConfigPath = path.join(tenantDir, 'pulse_config.json');

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(tenantDir, { recursive: true });

const advertisedStart = new Date(Date.now() + (2 * 60 * 1000)).toISOString();
const state = {
  ts: new Date().toISOString(),
  races: {
    'AUS:Canberra:R4': {
      country: 'AUS',
      meeting: 'Canberra',
      race_number: 4,
      race_status: 'Open',
      advertised_start: advertisedStart,
      runners: [
        { runner_name: 'Scope Watch', fixed_win: 5.5 },
        { runner_name: 'Market Neutral', fixed_win: 5.5 },
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
    'AUS:Canberra:R4|scope watch': 5.5,
    'AUS:Canberra:R4|market neutral': 5.5,
  },
  marketOddsHistory: {
    'AUS:Canberra:R4|scope watch': [{ ts: Date.now() - 10 * 60 * 1000, odds: 5.5 }],
    'AUS:Canberra:R4|market neutral': [{ ts: Date.now() - 10 * 60 * 1000, odds: 5.5 }],
  },
  marketOddsOpening: {
    'AUS:Canberra:R4|scope watch': 5.5,
    'AUS:Canberra:R4|market neutral': 5.5,
  },
};

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.writeFileSync(statusPath, JSON.stringify(previousStatus, null, 2));
fs.writeFileSync(alertsPath, JSON.stringify({ updatedAt: null, alerts: [] }, null, 2));
fs.writeFileSync(historyPath, JSON.stringify([], null, 2));
fs.writeFileSync(trackedBetsPath, JSON.stringify([
  { meeting: 'Canberra', race: '4', selection: 'Scope Watch', betType: 'Watch', status: 'active' },
], null, 2));
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
    maxMinsToJump: 10,
    minMovePct: 5,
    trackedRunnerOverride: true,
  },
  targeting: {
    mode: 'races',
    countries: ['AUS'],
    meetings: ['Canberra'],
    races: ['Canberra::4'],
  },
}, null, 2));

execFileSync('node', [path.join(root, 'scripts', 'status_writer.js'), `--state_path=${statePath}`, `--status_path=${statusPath}`], {
  cwd: root,
  env: { ...process.env, TENANT_ID: tenantId },
  stdio: 'pipe',
});

const alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
const jumpPulse = alertsFeed.alerts.find((a) => a.type === 'jump_pulse' && a.selection === 'Scope Watch');
assert(jumpPulse, 'expected jump pulse for tracked watch runner even without a market mover');
assert.strictEqual(jumpPulse.meeting, 'Canberra');
assert.strictEqual(String(jumpPulse.race), '4');
assert(jumpPulse.minsToJump >= 0 && jumpPulse.minsToJump <= 3, 'jump pulse should derive mins-to-jump from race state');
assert.strictEqual(jumpPulse.trackedRunner, true);

console.log('pulse_jump_pulse_without_mover.test.js: ok');
