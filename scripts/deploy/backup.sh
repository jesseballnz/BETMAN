#!/usr/bin/env bash
# backup.sh — Nightly BETMAN backup (database + data directories).
#
# Usage:
#   bash scripts/deploy/backup.sh              # uses defaults
#   BACKUP_DIR=/mnt/backups BACKUP_KEEP_DAYS=14 bash scripts/deploy/backup.sh
#
# What it backs up:
#   1. PostgreSQL pg_dump of the betman database
#   2. memory/  and frontend/data/ directories (JSON state files)
#
# Schedule via cron or systemd timer:
#   0 2 * * * cd /path/to/BETMAN && bash scripts/deploy/backup.sh >> /var/log/betman-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

DB_NAME="${BETMAN_DB_NAME:-betman}"
DB_USER="${BETMAN_DB_USER:-betman}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DAY_DIR="${BACKUP_DIR}/${STAMP}"

mkdir -p "${DAY_DIR}"

echo "[backup] started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[backup] target  ${DAY_DIR}"

# ── 1. PostgreSQL dump ──────────────────────────────────────────────────────
DB_FILE="${DAY_DIR}/betman-db-${STAMP}.sql.gz"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump -U "${DB_USER}" "${DB_NAME}" | gzip > "${DB_FILE}" && \
    echo "[backup] pg_dump → ${DB_FILE}" || \
    echo "[backup] pg_dump failed (non-fatal)"
else
  echo "[backup] pg_dump not found — skipping database backup"
fi

# ── 2. Data directories ────────────────────────────────────────────────────
DATA_FILE="${DAY_DIR}/betman-data-${STAMP}.tar.gz"
DIRS_TO_BACKUP=""
for d in memory frontend/data sporter/data sporter/memory data/meeting_profiles; do
  [ -d "${ROOT}/${d}" ] && DIRS_TO_BACKUP="${DIRS_TO_BACKUP} ${d}"
done

if [ -n "${DIRS_TO_BACKUP}" ]; then
  # shellcheck disable=SC2086
  tar -czf "${DATA_FILE}" -C "${ROOT}" ${DIRS_TO_BACKUP} 2>/dev/null && \
    echo "[backup] data   → ${DATA_FILE}" || \
    echo "[backup] tar failed (non-fatal)"
else
  echo "[backup] no data directories to back up"
fi

# ── 3. Rotate old backups ──────────────────────────────────────────────────
if [ "${BACKUP_KEEP_DAYS}" -gt 0 ]; then
  find "${BACKUP_DIR}" -maxdepth 1 -type d -mtime +"${BACKUP_KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true
  echo "[backup] rotated backups older than ${BACKUP_KEEP_DAYS} days"
fi

echo "[backup] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
