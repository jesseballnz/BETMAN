#!/usr/bin/env bash
set -euo pipefail

echo "Cron replacement complete. Use runtime jobs instead:"
echo "- npm run jobs:once   # one full cycle"
echo "- npm run jobs:run    # continuous loop (no cron required)"
