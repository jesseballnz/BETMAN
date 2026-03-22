#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
USER_NAME="${BETMAN_USERNAME:-betman}"
USER_PASS="${BETMAN_PASSWORD:-change-me-now}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "[smoke] login"
curl -sS -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login" \
  -H 'content-type: application/json' \
  --data "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" >/tmp/autobet_login.json

echo "[smoke] save autobet settings"
curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/autobet-settings" \
  -H 'content-type: application/json' \
  --data '{"enabled":false,"mode":"watch","platform":"TAB","username":"demo","password":"secret"}' >/tmp/autobet_save.json

echo "[smoke] fetch autobet settings"
SETTINGS_JSON="$(curl -sS -b "$COOKIE_JAR" "$BASE_URL/api/autobet-settings")"
echo "$SETTINGS_JSON" | grep -q '"platform":"TAB"'

echo "[smoke] queue AI bet"
QUEUE_JSON="$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/place-ai-bets" \
  -H 'content-type: application/json' \
  --data '{"bets":[{"meeting":"SmokeMeeting","race":"1","selection":"Smoke Runner","stake":1,"type":"Win","odds":"3.2","eta":"upcoming"}]}')"

echo "$QUEUE_JSON" | grep -q '"ok":true'
echo "[smoke] PASS"
