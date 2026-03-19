const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL || process.env.BETMAN_DATABASE_URL || '';
let pool;

function getPool(){
  if (!DB_URL) return null;
  if (pool) return pool;
  pool = new Pool({ connectionString: DB_URL });
  pool.on('error', (err) => console.error('[db_store] pool error:', err.message));
  return pool;
}

async function closePool(){
  if (pool) { await pool.end().catch(()=>{}); pool = null; }
}

async function ensureSchema(pg){
  if (!pg) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS betman_data (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS betman_audit (
      tenant_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      date TEXT,
      payload JSONB NOT NULL,
      PRIMARY KEY (tenant_id, ts)
    )
  `);
}

async function upsertData(pg, { tenantId = 'default', key, payload, updatedAt = null }){
  if (!pg || !key) return;
  const ts = updatedAt ? new Date(updatedAt) : new Date();
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error(`Invalid payload for key ${key}`);
  await pg.query(
    `INSERT INTO betman_data (tenant_id, key, payload, updated_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, key) DO UPDATE
     SET payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
    [tenantId, key, json, ts]
  );
}

async function loadData(pg, { tenantId = 'default', key }){
  if (!pg || !key) return null;
  const r = await pg.query(
    'SELECT payload FROM betman_data WHERE tenant_id=$1 AND key=$2 LIMIT 1',
    [tenantId, key]
  );
  if (!r.rows?.length) return null;
  return r.rows[0].payload;
}

async function appendAudit(pg, { tenantId = 'default', row }){
  if (!pg || !row) return;
  const ts = row.ts ? new Date(row.ts) : new Date();
  await pg.query(
    `INSERT INTO betman_audit (tenant_id, ts, date, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, ts) DO NOTHING`,
    [tenantId, ts, row.date || null, JSON.stringify(row)]
  );
}

module.exports = {
  getPool,
  closePool,
  ensureSchema,
  upsertData,
  loadData,
  appendAudit
};
