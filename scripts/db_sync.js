#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getPool, closePool, ensureSchema, upsertData, appendAudit } = require('./db_store');

function getArg(name, def = null){
  const idx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (idx === -1) return def;
  return process.argv[idx].split('=').slice(1).join('=') || def;
}

function loadJson(p){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function listTenants(root){
  const dir = path.join(root, 'memory', 'tenants');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isDirectory());
}

function readJsonlTail(filePath, tailCount){
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const slice = tailCount ? lines.slice(-tailCount) : lines;
  return slice.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function syncTenant({ root, tenantId, keys, auditMode, auditTail }){
  const pg = getPool();
  if (!pg) return;
  await ensureSchema(pg);

  const dataDir = tenantId === 'default'
    ? path.join(root, 'frontend', 'data')
    : path.join(root, 'memory', 'tenants', tenantId, 'frontend-data');

  for (const key of keys) {
    const p = path.join(dataDir, key);
    if (!fs.existsSync(p)) continue;
    const payload = loadJson(p);
    if (payload == null) continue;
    const updatedAt = payload.updatedAt || payload.updated_at || null;
    await upsertData(pg, { tenantId, key, payload, updatedAt });
  }

  if (auditMode !== 'none') {
    const auditPath = tenantId === 'default'
      ? path.join(root, 'memory', 'bet-plan-audit.jsonl')
      : path.join(root, 'memory', 'tenants', tenantId, 'bet-plan-audit.jsonl');
    const rows = auditMode === 'tail'
      ? readJsonlTail(auditPath, auditTail)
      : readJsonlTail(auditPath, null);
    for (const row of rows) {
      await appendAudit(pg, { tenantId, row });
    }
  }
}

async function main(){
  const root = path.resolve(__dirname, '..');
  const tenantArg = getArg('tenant');
  const keysArg = getArg('keys');
  const auditMode = (getArg('audit', 'full') || 'full').toLowerCase();
  const auditTail = parseInt(getArg('auditTail', '1'), 10) || 1;

  const defaultKeys = [
    'status.json',
    'stake.json',
    'success_daily.json',
    'success_weekly.json',
    'success_monthly.json',
    'races.json',
    'feel_meter.json',
    'placed_bets.json',
    'ai_bet_queue.json'
  ];

  const keys = keysArg
    ? keysArg.split(',').map(s => s.trim()).filter(Boolean)
    : defaultKeys;

  const tenants = tenantArg
    ? [tenantArg]
    : ['default', ...listTenants(root)];

  for (const tenantId of tenants) {
    try {
      await syncTenant({ root, tenantId, keys, auditMode, auditTail });
    } catch (err) {
      console.error(`[db_sync] tenant ${tenantId} failed:`, err.message || err);
    }
  }

  await closePool();
}

main().catch(async err => {
  console.error('[db_sync] failed', err.message || err);
  await closePool().catch(()=>{});
  process.exit(1);
});
