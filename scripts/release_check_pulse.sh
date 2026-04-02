#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/2] Running deterministic Pulse release evidence test"
node tests/pulse_release_evidence.test.js

echo "[2/2] Running existing Pulse generation regression test"
node tests/alerts_generation.test.js

echo "Pulse release check passed."
