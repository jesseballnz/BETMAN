#!/usr/bin/env bash
set -euo pipefail
# Load OpenClaw secrets if present
if [[ -f "$HOME/.openclaw/workspace/secrets/env.sh" ]]; then
  source "$HOME/.openclaw/workspace/secrets/env.sh"
fi

Q="${1:-}"
if [[ -z "$Q" ]]; then
  echo "Usage: brave_search.sh \"your query\""
  exit 1
fi

if [[ -z "${BRAVE_SEARCH_API_KEY:-}" ]]; then
  echo "BRAVE_SEARCH_API_KEY is not set"
  exit 1
fi

TMP="$(mktemp)"
HDR="$(mktemp)"
trap 'rm -f "$TMP" "$HDR"' EXIT

# Fetch (save body + headers so we can diagnose non-JSON responses)
HTTP_CODE="$(
  curl -sS -G "https://api.search.brave.com/res/v1/web/search" \
    --data-urlencode "q=${Q}" \
    --data-urlencode "count=7" \
    -H "Accept: application/json" \
    -H "X-Subscription-Token: ${BRAVE_SEARCH_API_KEY}" \
    -D "$HDR" \
    -o "$TMP" \
    -w "%{http_code}"
)"

# If not 200, show a useful error and the first chunk of the body
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Brave Search API error: HTTP $HTTP_CODE"
  echo "--- Response headers ---"
  sed -n '1,40p' "$HDR"
  echo "--- Response body (first 600 chars) ---"
  head -c 600 "$TMP"
  echo
  exit 2
fi

# Validate JSON before parsing
python3 - <<'PY' "$TMP"
import json, sys
path = sys.argv[1]
with open(path, "rb") as f:
    raw = f.read()
try:
    data = json.loads(raw)
except Exception as e:
    print("Brave returned non-JSON response (first 600 chars):")
    print(raw[:600].decode("utf-8", "replace"))
    raise

web = (data.get("web") or {}).get("results") or []
if not web:
    print("No results.")
    sys.exit(0)

for i, r in enumerate(web[:7], start=1):
    title = (r.get("title") or "").strip()
    url = (r.get("url") or "").strip()
    desc = (r.get("description") or "").strip()
    if title and url:
        print(f"{i}. {title}\n   {url}\n   {desc}\n")
PY
