const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const runId = `${Date.now()}_${process.pid}`;
const tmpDir = path.join(__dirname, 'tmp', 'pulse_release_evidence', runId);
const tenantId = `test_pulse_release_evidence_${runId}`;
const statePath = path.join(tmpDir, 'state.json');
const statusPath = path.join(tmpDir, 'status.json');
const tenantDir = path.join(root, 'memory', 'tenants', tenantId, 'frontend-data');
const alertsPath = path.join(tenantDir, 'alerts_feed.json');
const historyPath = path.join(tenantDir, 'alerts_history.json');
const pulseConfigPath = path.join(tenantDir, 'pulse_config.json');
const trackedBetsPath = path.join(tenantDir, 'tracked_bets.json');

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(tenantDir, { recursive: true });

const advertisedStart = new Date(Date.now() + (2 * 60 * 1000)).toISOString();
const state = {
  ts: new Date().toISOString(),
  races: {
    'NZ:Ashburton:R1': {
      country: 'NZ',
      meeting: 'Ashburton',
      race_number: 1,
      race_status: 'Open',
      advertised_start: advertisedStart,
      runners: [
        { runner_name: 'Alpha Pulse', fixed_win: 7.5 },
        { runner_name: 'Beta Noise', fixed_win: 2.8 }
      ]
    },
    'AUS:Randwick:R2': {
      country: 'AUS',
      meeting: 'Randwick',
      race_number: 2,
      race_status: 'Open',
      advertised_start: advertisedStart,
      runners: [
        { runner_name: 'Off Scope', fixed_win: 5.5 },
        { runner_name: 'Away We Go', fixed_win: 3.4 }
      ]
    }
  },
  bet_plans: [],
  candidates: [],
  next_races: []
};

const previousStatus = {
  suggestedBets: [],
  interestingRunners: [],
  marketOddsSnapshot: {
    'NZ:Ashburton:R1|alpha pulse': 10.0,
    'NZ:Ashburton:R1|beta noise': 2.8,
    'AUS:Randwick:R2|off scope': 7.4,
    'AUS:Randwick:R2|away we go': 3.4
  },
  marketOddsHistory: {
    'NZ:Ashburton:R1|alpha pulse': [{ ts: Date.now() - 10 * 60 * 1000, odds: 10.0 }],
    'NZ:Ashburton:R1|beta noise': [{ ts: Date.now() - 10 * 60 * 1000, odds: 2.8 }],
    'AUS:Randwick:R2|off scope': [{ ts: Date.now() - 10 * 60 * 1000, odds: 7.4 }],
    'AUS:Randwick:R2|away we go': [{ ts: Date.now() - 10 * 60 * 1000, odds: 3.4 }]
  },
  marketOddsOpening: {
    'NZ:Ashburton:R1|alpha pulse': 10.0,
    'NZ:Ashburton:R1|beta noise': 2.8,
    'AUS:Randwick:R2|off scope': 7.4,
    'AUS:Randwick:R2|away we go': 3.4
  }
};

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.writeFileSync(statusPath, JSON.stringify(previousStatus, null, 2));
fs.writeFileSync(alertsPath, JSON.stringify({ updatedAt: null, alerts: [] }, null, 2));
fs.writeFileSync(historyPath, JSON.stringify([], null, 2));
fs.writeFileSync(trackedBetsPath, JSON.stringify([
  { meeting: 'Ashburton', race: '1', selection: 'Alpha Pulse', betType: 'Win', status: 'active' }
], null, 2));
fs.writeFileSync(pulseConfigPath, JSON.stringify({
  enabled: true,
  alertTypes: {
    plunges: true,
    drifts: true,
    conflicts: true,
    selectionFlips: true,
    preJumpHeat: true,
    jumpPulse: true
  },
  thresholds: {
    minSeverity: 'HOT',
    maxMinsToJump: 10,
    minMovePct: 0,
    trackedRunnerOverride: true
  },
  targeting: {
    mode: 'races',
    countries: ['NZ'],
    meetings: ['Ashburton'],
    races: ['Ashburton::1']
  }
}, null, 2));

execFileSync('node', [path.join(root, 'scripts', 'status_writer.js'), `--state_path=${statePath}`, `--status_path=${statusPath}`], {
  cwd: root,
  env: { ...process.env, TENANT_ID: tenantId },
  stdio: 'pipe'
});

const alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
assert(Array.isArray(alertsFeed.alerts), 'alerts feed should contain alerts array');
assert(alertsFeed.alerts.length > 0, 'expected non-empty scoped Pulse alerts for release evidence');
assert(alertsFeed.alerts.some(a => a.selection === 'Alpha Pulse'), 'expected scoped Ashburton alert to survive targeting');
assert(alertsFeed.alerts.some(a => a.type === 'jump_pulse' && a.selection === 'Alpha Pulse'), 'expected tracked-runner jump pulse evidence');
assert(alertsFeed.alerts.every(a => a.meeting === 'Ashburton' && String(a.race) === '1'), 'all release evidence alerts should stay inside configured race scope');
assert(alertsFeed.alerts.every(a => a.country === 'NZ' || a.country == null), 'alerts should stay inside configured country scope');
assert(!alertsFeed.alerts.some(a => a.selection === 'Off Scope'), 'off-scope race should not leak into Pulse evidence');

console.log('pulse release evidence test passed');
