-- BETMAN database schema
-- Run with: psql -U betman -d betman -f scripts/deploy/schema.sql
-- All tables use IF NOT EXISTS so this is safe to re-run.

-- Tenant data store — key/value with JSONB payloads
CREATE TABLE IF NOT EXISTS betman_data (
  tenant_id  TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, key)
);

-- Append-only audit log for bet-plan decisions
CREATE TABLE IF NOT EXISTS betman_audit (
  tenant_id TEXT        NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  date      TEXT,
  payload   JSONB       NOT NULL,
  PRIMARY KEY (tenant_id, ts)
);

-- Singleton auth state — only one row (id = 1) is allowed.
-- The CHECK constraint enforces this at the database level so all
-- reads/writes target the single canonical row.
CREATE TABLE IF NOT EXISTS betman_auth_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  username   TEXT    NOT NULL,
  password   TEXT    NOT NULL,
  users      JSONB   NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
