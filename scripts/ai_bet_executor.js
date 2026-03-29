#!/usr/bin/env node
/* Move queued AI bets to placed bets once 30s queue timer expires. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function loadJson(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

const ROOT = path.resolve(__dirname, '..');
const tenantId = String(process.env.TENANT_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
const isDefaultTenant = tenantId === 'default';
const tenantDataDir = path.join(ROOT, 'memory', 'tenants', tenantId, 'frontend-data');
const queuePath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'ai_bet_queue.json') : path.join(tenantDataDir, 'ai_bet_queue.json');
const placedPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'placed_bets.json') : path.join(tenantDataDir, 'placed_bets.json');

const queue = loadJson(queuePath, []);
if (!queue.length) process.exit(0);

const now = Date.now();
const due = [];
const pending = [];

for (const q of queue) {
  const at = Number(q.placeAfterMs || 0);
  if (at > 0 && at <= now) due.push(q);
  else pending.push(q);
}

if (!due.length) process.exit(0);

const placed = loadJson(placedPath, []);
const stamped = due.map(x => ({
  meeting: x.meeting,
  race: x.race,
  selection: x.selection,
  stake: x.stake,
  type: x.type,
  odds: x.odds,
  eta: x.eta,
  sortTime: x.sortTime,
  source: x.source || 'ai-plan',
  queuedAt: x.queuedAt,
  placedAt: new Date().toISOString()
}));

writeJson(placedPath, [...placed, ...stamped]);
writeJson(queuePath, pending);

spawnSync('node', [path.join(ROOT, 'scripts', 'status_writer.js')], {
  stdio: 'ignore',
  env: { ...process.env, TENANT_ID: tenantId }
});
console.log(`ai_bet_executor: moved ${stamped.length} queued bets to placed for tenant=${tenantId}`);
