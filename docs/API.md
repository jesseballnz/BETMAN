# BETMAN API — Developer Guide

> **AI-Powered Horse Racing Intelligence**
> Version 1.0.0 • Commercial API

---

## Overview

The BETMAN API provides programmatic access to AI-powered horse racing
intelligence. Use it to retrieve race data, AI-suggested bets,
market movers, and performance analytics — the same intelligence that
drives the BETMAN platform.

**Base URL**

```
https://your-betman-instance/api/v1
```

All API endpoints are served under the `/api/v1/` path prefix.

---

## Quick Start

### 1. Get an API Key

Log in to the BETMAN web dashboard and navigate to **Settings → API Keys**,
or ask your administrator to provision one for you.

Alternatively, create a key via the session-authenticated endpoint:

```bash
curl -X POST https://betman.example.com/api/api-keys \
  -H "Cookie: betman_session=YOUR_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"label": "My Integration"}'
```

Response:

```json
{
  "ok": true,
  "key": "bm_a1b2c3d4e5f6...",
  "label": "My Integration",
  "message": "Store this key securely — it cannot be retrieved again."
}
```

### 2. Make Your First Request

```bash
curl https://betman.example.com/api/v1/races \
  -H "X-API-Key: bm_a1b2c3d4e5f6..."
```

---

## Authentication

Every request to authenticated endpoints must include a valid API key.
Two methods are supported:

| Method | Example |
|--------|---------|
| **Header (recommended)** | `X-API-Key: bm_abc123...` |
| **Query parameter** | `?api_key=bm_abc123...` |

The header method is preferred because it keeps the key out of
server access logs and browser history.

### API Key Format

All BETMAN API keys begin with the prefix `bm_` followed by 48
hexadecimal characters (51 characters total).

### Error Responses

| HTTP Status | Error Code | Meaning |
|-------------|------------|---------|
| `401` | `api_key_required` | No API key was provided |
| `401` | `invalid_api_key` | The key is invalid or revoked |
| `429` | `rate_limit_exceeded` | Too many requests |

---

## Rate Limiting

Each API key has a configurable rate limit (default: **60 requests per
60-second window**). The following headers are included in every
authenticated response:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Window` | Window duration in seconds |
| `Retry-After` | Seconds to wait (only present on 429 responses) |

When rate-limited, wait for the `Retry-After` duration before retrying.

---

## Response Format

All responses are JSON with a consistent envelope:

```json
{
  "ok": true,
  "api_version": "1.0.0",
  ...
}
```

Error responses include `error` and `message` fields:

```json
{
  "ok": false,
  "error": "error_code",
  "message": "Human-readable explanation.",
  "api_version": "1.0.0"
}
```

---

## Endpoints

### Public Endpoints

These do not require authentication.

---

#### `GET /api/v1/health`

Health check. Use for monitoring and uptime checks.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "service": "BETMAN Racing Intelligence API",
  "timestamp": "2026-03-26T12:00:00.000Z"
}
```

---

#### `GET /api/v1/version`

Returns API version and product information.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "product": "BETMAN",
  "description": "AI-Powered Horse Racing Intelligence",
  "documentation": "/docs/API.md"
}
```

---

### Authenticated Endpoints

All of the following require a valid API key.

---

#### `GET /api/v1/me`

Returns information about the authenticated user.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "user": {
    "username": "punter@example.com",
    "role": "user",
    "isAdmin": false,
    "planType": "single"
  }
}
```

---

#### `GET /api/v1/races`

Returns today's race card.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `country` | string | Filter by country code (e.g. `NZ`, `AUS`, `HK`) |
| `meeting` | string | Filter by meeting name (case-insensitive partial match) |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "count": 12,
  "races": [
    {
      "meeting": "Pukekohe",
      "race_number": "3",
      "description": "Maiden 1200m",
      "distance": "1200m",
      "track_condition": "Good 3",
      "weather": "Fine",
      "country": "NZ",
      "start_time": "2026-03-26T02:30:00Z",
      "runner_count": 14
    }
  ]
}
```

---

#### `GET /api/v1/races/:meeting/:race_number`

Returns full detail for a specific race including all runners.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `meeting` | string | Meeting name (URL-encoded, partial match) |
| `race_number` | integer | Race number |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "race": {
    "meeting": "Pukekohe",
    "race_number": "3",
    "description": "Maiden 1200m",
    "distance": "1200m",
    "track_condition": "Good 3",
    "weather": "Fine",
    "country": "NZ",
    "start_time": "2026-03-26T02:30:00Z",
    "runners": [
      {
        "number": "1",
        "name": "Star Runner",
        "barrier": 3,
        "weight": "57.0",
        "jockey": "J. Smith",
        "trainer": "T. Jones",
        "odds": 3.50,
        "form": "x2311",
        "speedmap": "leader"
      }
    ]
  }
}
```

---

#### `GET /api/v1/suggested-bets`

Returns AI-generated suggested bets for today's races.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "count": 5,
  "updatedAt": "2026-03-26T12:00:00.000Z",
  "suggestedBets": [
    {
      "meeting": "Ellerslie",
      "race": "4",
      "selection": "Fast Horse",
      "type": "Win",
      "aiWinProb": 45.2,
      "stake": 7.00,
      "odds": 3.50,
      "signal": "strong_value"
    }
  ]
}
```

---

#### `GET /api/v1/interesting-runners`

Returns runners flagged by AI as noteworthy.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "count": 3,
  "interestingRunners": [
    {
      "meeting": "Pukekohe",
      "race": "6",
      "runner": "Dark Horse",
      "reason": "Significant market support, barrier advantage",
      "odds": 8.00,
      "probability": 22.5
    }
  ]
}
```

---

#### `GET /api/v1/market-movers`

Returns runners with significant odds movements.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `meeting` | string | Filter by meeting name (case-insensitive partial match) |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "count": 8,
  "marketMovers": [
    {
      "meeting": "Pukekohe",
      "race": "3",
      "runner": "Star Runner",
      "previousOdds": 6.00,
      "currentOdds": 3.50,
      "direction": "firming",
      "magnitude": 2.50
    }
  ]
}
```

---

#### `GET /api/v1/status`

Returns a summary of the current system status.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "updatedAt": "2026-03-26T12:00:00.000Z",
  "balance": 250.00,
  "openBets": 3,
  "feelMeter": { "score": 72, "wins": 5, "losses": 3 },
  "upcomingRaceCount": 8,
  "suggestedBetCount": 5
}
```

---

#### `GET /api/v1/performance`

Returns betting performance data.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | string | `daily` | One of: `daily`, `weekly`, `monthly` |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "period": "daily",
  "data": { ... }
}
```

---

#### `GET /api/v1/stake-config`

Returns the current staking configuration.

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "stakePerRace": 7,
  "exoticStakePerRace": 2.5,
  "earlyWindowMin": 3600,
  "aiWindowMin": 30,
  "betHarderMultiplier": 1.5
}
```

---

#### `GET /api/v1/bet-history`

Returns placed bets and their results.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Max records to return (max 200) |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "placedBets": [ ... ],
  "betResults": [ ... ]
}
```

---

#### `POST /api/v1/ask-betman` ⭐

**The core "Ask BETMAN" endpoint.** Submit a natural-language question
about today's races and receive AI-powered analysis.

**Request Body**

```json
{
  "question": "Who should I bet on at Pukekohe Race 3?",
  "meeting": "pukekohe",
  "race": "3",
  "selection": "Star Runner"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `question` | string | ✅ | Your question (max 2000 chars) |
| `meeting` | string | ❌ | Meeting name to focus the analysis |
| `race` | string | ❌ | Race number to focus the analysis |
| `selection` | string | ❌ | Specific runner to analyse |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "question": "Who should I bet on at Pukekohe Race 3?",
  "context": {
    "racesAvailable": 24,
    "suggestedBetCount": 5,
    "marketMoverCount": 12,
    "matchedRace": {
      "meeting": "Pukekohe",
      "race": "3",
      "runners": 14,
      "trackCondition": "Good 3"
    }
  },
  "analysis": {
    "matchedRace": {
      "meeting": "Pukekohe",
      "raceNumber": "3",
      "description": "Maiden 1200m",
      "distance": "1200m",
      "trackCondition": "Good 3",
      "runners": [
        {
          "number": "1",
          "name": "Star Runner",
          "odds": 3.50,
          "barrier": 3,
          "jockey": "J. Smith",
          "trainer": "T. Jones"
        }
      ]
    },
    "suggestedBets": [ ... ],
    "marketMovers": [ ... ],
    "interestingRunners": [ ... ]
  }
}
```

---

### API Key Management

Keys can be managed via the session-authenticated web endpoints or
through the API v1 key management routes.

---

#### `GET /api/v1/keys`

List API keys. Admins see all keys; regular users see only their own.
Key values are masked (only the prefix is shown).

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "keys": [
    {
      "username": "punter@example.com",
      "role": "user",
      "label": "My Integration",
      "keyPrefix": "bm_a1b2c3…",
      "active": true,
      "createdAt": "2026-03-26T12:00:00.000Z"
    }
  ]
}
```

---

#### `POST /api/v1/keys`

Create a new API key. Admins can create keys for any user.

**Request Body**

```json
{
  "label": "Production Bot",
  "username": "punter@example.com",
  "rateLimit": 120,
  "rateWindow": 60
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `label` | string | `"API Key"` | Human-readable label (max 100 chars) |
| `username` | string | current user | Target user (admin only) |
| `rateLimit` | integer | 60 | Requests per window (admin only) |
| `rateWindow` | integer | 60 | Window duration in seconds (admin only) |

**Response (201)**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "message": "API key created. Store the key securely — it cannot be retrieved again.",
  "key": "bm_a1b2c3d4e5f6...",
  "label": "Production Bot",
  "username": "punter@example.com",
  "rateLimit": 120,
  "rateWindow": 60,
  "createdAt": "2026-03-26T12:00:00.000Z"
}
```

> ⚠️ **Important:** The full key is only returned once at creation time.
> Store it securely.

---

#### `DELETE /api/v1/keys`

Revoke an API key.

**Request Body**

```json
{
  "key": "bm_a1b2c3d4e5f6..."
}
```

Or by prefix:

```json
{
  "keyPrefix": "bm_a1b2c3"
}
```

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "message": "API key revoked."
}
```

---

### Admin-Only: TAB API Proxy 🔒

These endpoints proxy requests to the TAB NZ Affiliates API and
are **restricted to admin accounts**. Non-admin API keys receive
a `403 admin_required` error.

---

#### `GET /api/v1/tab/meetings`

List racing meetings from the TAB API.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `date` | string | `today` | Date (`YYYY-MM-DD` or `today`) |
| `country` | string | `NZ` | Country code: `NZ`, `AUS`, `HK` |
| `type` | string | `T` | Race type (T = Thoroughbred) |
| `limit` | integer | 200 | Max results |
| `offset` | integer | 0 | Pagination offset |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "source": "tab_nz_affiliates",
  "params": { "date": "today", "country": "NZ", "type": "T" },
  "data": { ... }
}
```

---

#### `GET /api/v1/tab/events/:event_id`

Get full event details from the TAB API including runners, odds,
form, fluctuations, money tracker, and big bets data.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `event_id` | string | TAB event ID |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "source": "tab_nz_affiliates",
  "eventId": "12345",
  "data": { ... }
}
```

---

#### `GET /api/v1/tab/races`

List races by broadcast channel from the TAB API.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `channel` | string | `Trackside1` | Channel: `Trackside1`, `Trackside2`, `Live1`, `Live2`, `NoVideos` |
| `date` | string | `today` | Date |
| `type` | string | `T` | Race type |

**Response**

```json
{
  "ok": true,
  "api_version": "1.0.0",
  "source": "tab_nz_affiliates",
  "params": { "channel": "Trackside1", "date": "today", "type": "T" },
  "data": { ... }
}
```

---

## Session-Authenticated Key Management

These endpoints use session cookies (from the BETMAN web login) rather
than API keys. Use them from the BETMAN dashboard or with `curl`
after authenticating via `/api/login`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/api-keys` | List your API keys |
| `POST` | `/api/api-keys` | Create a new API key |
| `POST` | `/api/api-keys/revoke` | Revoke an API key by prefix |

---

## Error Reference

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `missing_question` | The `question` field is required |
| 400 | `question_too_long` | Question exceeds 2000 characters |
| 400 | `invalid_period` | Invalid performance period |
| 400 | `missing_key` | No key identifier provided for revocation |
| 401 | `api_key_required` | No API key was provided |
| 401 | `invalid_api_key` | API key is invalid or revoked |
| 403 | `admin_required` | Endpoint restricted to admin accounts |
| 403 | `forbidden` | Operation not permitted for this user |
| 404 | `not_found` | Endpoint or resource not found |
| 404 | `race_not_found` | No matching race found |
| 404 | `user_not_found` | Target user not found |
| 404 | `key_not_found` | No matching API key found |
| 429 | `rate_limit_exceeded` | Rate limit exceeded |
| 500 | `internal_error` | Unexpected server error |
| 502 | `tab_api_error` | TAB API returned an error |
| 502 | `tab_api_unreachable` | TAB API is unreachable |

---

## Code Examples

### Python

```python
import requests

API_KEY = "bm_your_key_here"
BASE = "https://betman.example.com/api/v1"
headers = {"X-API-Key": API_KEY}

# Get today's races
races = requests.get(f"{BASE}/races", headers=headers).json()
print(f"Today: {races['count']} races")

# Get suggested bets
bets = requests.get(f"{BASE}/suggested-bets", headers=headers).json()
for bet in bets["suggestedBets"]:
    print(f"  {bet['meeting']} R{bet['race']}: {bet['selection']} @ {bet['odds']}")

# Ask BETMAN
answer = requests.post(f"{BASE}/ask-betman", headers=headers, json={
    "question": "Best value bet at Ellerslie today?",
    "meeting": "ellerslie"
}).json()
print(answer["analysis"])
```

### JavaScript / Node.js

```javascript
const API_KEY = 'bm_your_key_here';
const BASE = 'https://betman.example.com/api/v1';

async function askBetman(question, meeting) {
  const res = await fetch(`${BASE}/ask-betman`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ question, meeting })
  });
  return res.json();
}

// Usage
const result = await askBetman('Who wins Pukekohe R3?', 'pukekohe');
console.log(result.analysis);
```

### cURL

```bash
# Health check (no auth required)
curl https://betman.example.com/api/v1/health

# Get races
curl -H "X-API-Key: bm_your_key" https://betman.example.com/api/v1/races

# Ask BETMAN
curl -X POST https://betman.example.com/api/v1/ask-betman \
  -H "X-API-Key: bm_your_key" \
  -H "Content-Type: application/json" \
  -d '{"question": "Best bet at Pukekohe?", "meeting": "pukekohe"}'

# Admin: TAB meetings
curl -H "X-API-Key: bm_admin_key" \
  "https://betman.example.com/api/v1/tab/meetings?country=NZ"
```

---

## Pricing

The BETMAN API is available as part of the **BETMAN Commercial** plan
at **$250/month**. This includes:

- Unlimited API key generation
- 60 requests/minute default rate limit (configurable)
- All race intelligence endpoints
- AI-powered Ask BETMAN analysis
- Market mover tracking
- Performance analytics
- Priority support

Admin accounts additionally get access to the **TAB API Proxy**
endpoints for direct TAB NZ Affiliates data.

---

## Support

- **Documentation:** This file (`/docs/API.md`)
- **Health check:** `GET /api/v1/health`
- **Email:** support@betman.co.nz

---

*© 2026 BETMAN. All rights reserved.*
