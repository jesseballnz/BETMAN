#!/usr/bin/env bash
# setup_postgres.sh — Create the BETMAN database, user, and schema.
#
# Usage:
#   sudo -u postgres bash scripts/deploy/setup_postgres.sh
#   # or with custom values:
#   BETMAN_DB_NAME=betman BETMAN_DB_USER=betman BETMAN_DB_PASS=betman \
#     sudo -u postgres bash scripts/deploy/setup_postgres.sh
#
# This script is idempotent — safe to re-run.
set -euo pipefail

DB_NAME="${BETMAN_DB_NAME:-betman}"
DB_USER="${BETMAN_DB_USER:-betman}"
DB_PASS="${BETMAN_DB_PASS:-betman}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/schema.sql"

echo "[setup_postgres] database=${DB_NAME}  user=${DB_USER}"

# ── Create role if it doesn't exist ──────────────────────────────────────────
if psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  echo "[setup_postgres] role '${DB_USER}' already exists"
else
  psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
  echo "[setup_postgres] created role '${DB_USER}'"
fi

# ── Create database if it doesn't exist ──────────────────────────────────────
if psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "[setup_postgres] database '${DB_NAME}' already exists"
else
  psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  echo "[setup_postgres] created database '${DB_NAME}'"
fi

# ── Run schema ───────────────────────────────────────────────────────────────
psql -U "${DB_USER}" -d "${DB_NAME}" -f "${SCHEMA_FILE}"
echo "[setup_postgres] schema applied"

echo "[setup_postgres] done"
