# BETMAN API

Base URL (local):
- `http://localhost:8080`

Format:
- All API responses are JSON.
- All endpoints are read-only.

Authentication:
- HTTP Basic Auth is required for all routes (UI + API).
- Configure credentials with environment variables before starting server:
  - `BETMAN_USERNAME`
  - `BETMAN_PASSWORD`
- Defaults (must be changed):
  - username: `betman`
  - password: `change-me-now`

## Endpoints

### 1) Health
`GET /api/health`

Response:
```json
{
  "ok": true,
  "service": "betman-api",
  "ts": "2026-03-04T00:00:00.000Z"
}
```

### 2) Status Snapshot
`GET /api/status`

Returns the current status payload used by the BETMAN UI (`frontend/data/status.json`).

### 3) Races
`GET /api/races`

Query params:
- `date` (optional, `YYYY-MM-DD`) – tries `races-YYYY-MM-DD.json`, falls back to `races.json`
- `country` (optional, e.g. `NZ`, `AUS`, `HK`; `HKG` is accepted as legacy alias)
- `meeting` (optional, exact meeting name)
- `offset` (optional, integer, default `0`)
- `limit` (optional, integer, default `200`)

Example:
```bash
curl -u "$BETMAN_USERNAME:$BETMAN_PASSWORD" "http://localhost:8080/api/races?date=2026-03-04&country=NZ&limit=20"
```

Response shape:
```json
{
  "date": "2026-03-04",
  "updatedAt": "2026-03-03T22:18:48.977Z",
  "total": 54,
  "offset": 0,
  "limit": 20,
  "races": []
}
```

### 4) Suggested Bets
`GET /api/suggested-bets`

Query params:
- `offset` (optional, integer, default `0`)
- `limit` (optional, integer, default `50`)

Example:
```bash
curl -u "$BETMAN_USERNAME:$BETMAN_PASSWORD" "http://localhost:8080/api/suggested-bets?limit=10"
```

### 5) Interesting Runners
`GET /api/interesting-runners`

Query params:
- `offset` (optional, integer, default `0`)
- `limit` (optional, integer, default `50`)

Example:
```bash
curl -u "$BETMAN_USERNAME:$BETMAN_PASSWORD" "http://localhost:8080/api/interesting-runners?limit=10"
```

### 6) Ask Selection (AI Chat)
`POST /api/ask-selection`

Body:
```json
{ "question": "Why is Riccarton R2 top pick selected?" }
```

Example:
```bash
curl -u "$BETMAN_USERNAME:$BETMAN_PASSWORD" -X POST "http://localhost:8080/api/ask-selection" \
  -H "Content-Type: application/json" \
  -d '{"question":"top pick"}'
```

Response:
```json
{
  "ok": true,
  "mode": "ai",
  "answer": "..."
}
```

`mode` values:
- `ai` = LLM-generated answer (requires `OPENAI_API_KEY` or `BETMAN_OPENAI_API_KEY`)
- `fallback` = deterministic data answer if no LLM key/config available

### 7) Train Models (Admin)
`POST /api/train-models`

Notes:
- Admin-only (non-admins receive `403` + `admin_required`).
- Runs offline training: `scripts/betman_train_offline.py`.
- Used by the Performance page **Train Models** button.

Example:
```bash
curl -u "$BETMAN_USERNAME:$BETMAN_PASSWORD" -X POST "http://localhost:8080/api/train-models"
```

Response:
```json
{
  "ok": true,
  "output": "...",
  "error": ""
}
```

---

## Notes

- API is authenticated via HTTP Basic Auth.
- If exposed publicly, still place behind TLS/reverse proxy and add rate limits.
- Data freshness depends on poller/cron jobs updating `frontend/data/*.json`.
