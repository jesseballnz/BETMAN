#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/betman_env.sh"

cd "$ROOT_DIR"
echo "[betman-poller-launcher] starting adaptive poller from $ROOT_DIR"
exec "$ROOT_DIR/scripts/adaptive_poller_loop.sh"
