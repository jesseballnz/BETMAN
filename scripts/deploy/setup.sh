#!/usr/bin/env bash
# setup.sh — One-command BETMAN deployment.
#
# Usage:
#   bash scripts/deploy/setup.sh
#
# What it does:
#   1. Checks prerequisites (node, npm, python3, psql)
#   2. Installs Node.js dependencies
#   3. Creates required directories
#   4. (Optional) Sets up PostgreSQL database + schema
#   5. Copies env.example → .env if .env doesn't exist
#   6. Prints next-steps summary
#
# This script is idempotent — safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}"

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }

echo ""
echo "════════════════════════════════════════════════"
echo "  BETMAN — Deployment Setup"
echo "════════════════════════════════════════════════"
echo ""

# ── 1. Prerequisites ────────────────────────────────────────────────────────
echo "Checking prerequisites…"
MISSING=0

for cmd in node npm; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd $(${cmd} --version 2>/dev/null || echo '')"
  else
    fail "$cmd not found — install Node.js ≥18"
    MISSING=1
  fi
done

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>/dev/null | awk '{print $2}')"
else
  warn "python3 not found — some enrichment scripts will be skipped"
fi

if command -v psql >/dev/null 2>&1; then
  ok "psql (PostgreSQL client)"
else
  warn "psql not found — database setup will be skipped"
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  fail "Required tools missing. Install them and re-run."
  exit 1
fi

echo ""

# ── 2. Node.js dependencies ────────────────────────────────────────────────
echo "Installing Node.js dependencies…"
npm install --production 2>&1 | tail -3
ok "npm install complete"
echo ""

# ── 3. Directories ─────────────────────────────────────────────────────────
echo "Creating directories…"
for dir in memory frontend/data backups data/meeting_profiles sporter/data sporter/memory; do
  mkdir -p "${ROOT}/${dir}"
done
ok "directories created"
echo ""

# ── 4. Environment file ───────────────────────────────────────────────────
echo "Environment configuration…"
if [ ! -f "${ROOT}/.env" ]; then
  if [ -f "${ROOT}/scripts/deploy/env.example" ]; then
    cp "${ROOT}/scripts/deploy/env.example" "${ROOT}/.env"
    ok "copied env.example → .env  (edit .env with your values)"
  else
    warn "no env.example found"
  fi
else
  ok ".env already exists"
fi
echo ""

# ── 5. PostgreSQL (optional) ──────────────────────────────────────────────
echo "PostgreSQL setup…"
if command -v psql >/dev/null 2>&1; then
  echo "  Attempting to apply schema directly…"
  DB_NAME="${BETMAN_DB_NAME:-betman}"
  DB_USER="${BETMAN_DB_USER:-betman}"

  if psql -U "${DB_USER}" -d "${DB_NAME}" -f "${ROOT}/scripts/deploy/schema.sql" >/dev/null 2>&1; then
    ok "schema applied to ${DB_NAME}"
  else
    warn "Could not connect as ${DB_USER}@${DB_NAME}"
    echo "  To set up Postgres manually:"
    echo "    sudo -u postgres bash scripts/deploy/setup_postgres.sh"
  fi
else
  warn "psql not available — skipping database setup"
  echo "  Install PostgreSQL and run:  sudo -u postgres bash scripts/deploy/setup_postgres.sh"
fi
echo ""

# ── 6. Verify tests ──────────────────────────────────────────────────────
echo "Running tests…"
if npm test >/dev/null 2>&1; then
  ok "all tests pass"
else
  warn "some tests failed — review with: npm test"
fi
echo ""

# ── 7. Summary ───────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════"
echo "  Setup complete!"
echo "════════════════════════════════════════════════"
echo ""
echo "  Start services:"
echo "    npm run poll:start          # poll manager (all pollers)"
echo "    node scripts/frontend_server.js   # web UI"
echo ""
echo "  One-off commands:"
echo "    npm run jobs:once           # single poll cycle"
echo "    npm test                    # run test suite"
echo ""
echo "  Backups:"
echo "    bash scripts/deploy/backup.sh     # manual backup"
echo "    # Add to cron for nightly:"
echo "    # 0 2 * * * cd ${ROOT} && bash scripts/deploy/backup.sh"
echo ""
echo "  Environment:"
echo "    Edit .env with your DATABASE_URL, STRIPE keys, etc."
echo ""
