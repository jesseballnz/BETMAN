#!/usr/bin/env node
/* Move queued AI bets to placed bets once 30s queue timer expires. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { aiGoNoGo, placeTabBet } = require('./tab_live_adapter');

function loadEnv(file = '.env'){
  try {
    const envPath = path.join(process.cwd(), file);
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx < 0) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
      if (!process.env[key]) process.env[key] = value;
    });
  } catch {}
}

loadEnv('.env');

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
const autobetSettingsPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'autobet_settings.json') : path.join(tenantDataDir, 'autobet_settings.json');
const watchLogPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'autobet_watch_log.json') : path.join(tenantDataDir, 'autobet_watch_log.json');

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

const settings = loadJson(autobetSettingsPath, { mode: 'watch', platform: 'TAB' }) || { mode: 'watch', platform: 'TAB' };
const mode = String(settings.mode || 'watch').toLowerCase();
const nowIso = new Date().toISOString();

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
  placedAt: nowIso,
  platform: settings.platform || 'TAB',
  mode
}));

if (mode === 'watch') {
  const watchLog = loadJson(watchLogPath, []);
  const logged = stamped.map(x => ({ ...x, action: 'WATCH_ONLY', note: 'No real bet placed (watch mode)' }));
  writeJson(watchLogPath, [...watchLog, ...logged]);
  writeJson(queuePath, pending);
  spawnSync('node', [path.join(ROOT, 'scripts', 'status_writer.js')], { stdio: 'ignore' });
  console.log(`ai_bet_executor: watch mode logged ${logged.length} bets (no placement)`);
  process.exit(0);
}

const placed = loadJson(placedPath, []);
const watchLog = loadJson(watchLogPath, []);
const settingsForAi = {
  ...settings,
  minRouteConfidence: Number(settings.minRouteConfidence || 55),
  minSignalPct: Number(settings.minSignalPct || 40)
};

const accepted = [];
const blocked = [];
for (const order of stamped) {
  const ai = aiGoNoGo(order, settingsForAi);
  if (ai.decision !== 'GO') {
    blocked.push({ ...order, action: 'NO_GO', note: ai.reasons.join(', ') });
    continue;
  }
  const result = (String(settings.platform || 'TAB').toUpperCase() === 'TAB' || String(settings.platform || 'TAB').toUpperCase() === 'BOTH')
    ? placeTabBet(order, settingsForAi)
    : { ok: false, status: 'blocked', reasons: ['unsupported_platform'] };

  if (result.ok) {
    accepted.push({ ...order, action: 'BET_PLACED', execution: result });
  } else {
    blocked.push({ ...order, action: result.decision || 'NO_GO_REVIEW', note: (result.reasons || []).join(', '), execution: result });
  }
}

writeJson(placedPath, [...placed, ...accepted]);
writeJson(watchLogPath, [...watchLog, ...blocked]);
writeJson(queuePath, pending);

spawnSync('node', [path.join(ROOT, 'scripts', 'status_writer.js')], { stdio: 'ignore' });
console.log(`ai_bet_executor: bet mode accepted ${accepted.length}, blocked ${blocked.length}`);
