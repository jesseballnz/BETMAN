const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmpDir = path.join(__dirname, 'tmp', 'alerts_generation');
const tenantId = 'test_alerts_generation';
const statePath = path.join(tmpDir, 'state.json');
const statusPath = path.join(tmpDir, 'status.json');
const tenantDir = path.join(root, 'memory', 'tenants', tenantId, 'frontend-data');
const alertsPath = path.join(tenantDir, 'alerts_feed.json');
const historyPath = path.join(tenantDir, 'alerts_history.json');

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(tenantDir, { recursive: true });

const advertisedStart = new Date(Date.now() + (8 * 60 * 1000)).toISOString();
const state = {
  ts: new Date().toISOString(),
  races: {
    'AUS:Newcastle:R7': {
      meeting: 'Newcastle',
      race_number: 7,
      race_status: 'Open',
      advertised_start: advertisedStart,
      runners: [
        { runner_name: 'Wild Thoughts', fixed_win: 8.0 },
        { runner_name: 'Lord Of Biscay', fixed_win: 2.0 }
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
    'AUS:Newcastle:R7|wild thoughts': 4.0,
    'AUS:Newcastle:R7|lord of biscay': 2.5
  },
  marketOddsHistory: {
    'AUS:Newcastle:R7|wild thoughts': [{ ts: Date.now() - 10 * 60 * 1000, odds: 4.0 }],
    'AUS:Newcastle:R7|lord of biscay': [{ ts: Date.now() - 10 * 60 * 1000, odds: 2.5 }]
  },
  marketOddsOpening: {
    'AUS:Newcastle:R7|wild thoughts': 4.0,
    'AUS:Newcastle:R7|lord of biscay': 2.5
  }
};

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.writeFileSync(statusPath, JSON.stringify(previousStatus, null, 2));
fs.writeFileSync(alertsPath, JSON.stringify({ updatedAt: null, alerts: [] }, null, 2));
fs.writeFileSync(historyPath, JSON.stringify([], null, 2));

execFileSync('node', [path.join(root, 'scripts', 'status_writer.js'), `--state_path=${statePath}`, `--status_path=${statusPath}`], {
  cwd: root,
  env: { ...process.env, TENANT_ID: tenantId },
  stdio: 'pipe'
});

const alertsFeed = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
assert(Array.isArray(alertsFeed.alerts), 'alerts feed should contain alerts array');
assert(alertsFeed.alerts.length > 0, 'expected live alerts for meaningful untracked movers');
const critical = alertsFeed.alerts.find(a => a.selection === 'Wild Thoughts');
assert(critical, 'expected Wild Thoughts mover alert');
assert(['CRITICAL', 'HOT', 'ACTION'].includes(critical.severity), 'meaningful mover should be surfaced above INFO/WATCH');

console.log('alerts_generation tests passed');
