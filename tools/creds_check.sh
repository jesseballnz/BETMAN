#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.openclaw/workspace/secrets/tab.env"
source "$HOME/.openclaw/workspace/secrets/betcha.env"

echo "TAB user set?    $([[ -n "${TAB_USERNAME:-}" ]] && echo yes || echo no)"
echo "BETCHA user set? $([[ -n "${BETCHA_USERNAME:-}" ]] && echo yes || echo no)"
