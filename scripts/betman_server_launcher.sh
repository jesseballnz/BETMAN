#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/betman_env.sh"

cd "$ROOT_DIR"
echo "[betman-server-launcher] starting frontend server from $ROOT_DIR using $NODE_BIN"
exec "$NODE_BIN" scripts/frontend_server.js
