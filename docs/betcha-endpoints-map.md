# BETCHA Endpoint Map (observed from live BETCHA web client)

Captured from runtime network resources on `www.betcha.co.nz` using `performance.getEntriesByType('resource')`.

Base hosts observed:
- `https://api.betcha.co.nz`
- `https://status-api.production.betcha.co.nz`
- `https://api.trafficguard.ai` (anti-fraud/telemetry)

## Observed API paths

- `api.betcha.co.nz/gql/router`
- `api.betcha.co.nz/insights/sync`
- `api.betcha.co.nz/rest/v1/racing/`
- `api.betcha.co.nz/v2/alerts/List`
- `api.betcha.co.nz/v2/client-notifications/get-client-checkin-preferences`
- `api.betcha.co.nz/v2/client-notifications/list`
- `api.betcha.co.nz/v2/client/Balance`
- `api.betcha.co.nz/v2/client/TrackDevice`
- `api.betcha.co.nz/v2/client/get`
- `api.betcha.co.nz/v2/domain-featured/domain-featured-v2/ListQuickLinks`
- `api.betcha.co.nz/v2/event/market-rules`
- `api.betcha.co.nz/v2/finance/finance-v2/ListCreditCards`
- `api.betcha.co.nz/v2/metadata/GetByURL`
- `api.betcha.co.nz/v2/offers/ListCoupons`
- `api.betcha.co.nz/v2/racing/meeting`
- `api.betcha.co.nz/v2/toolbox/balances`
- `api.betcha.co.nz/v2/video/video-v2/ListChannels`
- `status-api.production.betcha.co.nz/index.json`
- `api.trafficguard.ai/tg-g-000932-003/api/v4/client-side/validate/event`

## Phase 2: AUTOBET relevance classification

### Critical for market discovery / runner mapping
- `api.betcha.co.nz/gql/router`
- `api.betcha.co.nz/v2/racing/meeting`
- `api.betcha.co.nz/rest/v1/racing/`
- `api.betcha.co.nz/v2/event/market-rules`

### Critical for account state / execution safety
- `api.betcha.co.nz/v2/client/Balance`
- `api.betcha.co.nz/v2/client/get`
- `api.betcha.co.nz/v2/toolbox/balances`

### Useful but non-core for placement
- `api.betcha.co.nz/v2/finance/finance-v2/ListCreditCards`
- `api.betcha.co.nz/v2/offers/ListCoupons`
- `api.betcha.co.nz/v2/video/video-v2/ListChannels`
- `api.betcha.co.nz/v2/domain-featured/domain-featured-v2/ListQuickLinks`
- `api.betcha.co.nz/v2/metadata/GetByURL`

### Non-core / telemetry / system status
- `api.betcha.co.nz/insights/sync`
- `api.betcha.co.nz/v2/client/TrackDevice`
- `api.betcha.co.nz/v2/client-notifications/*`
- `api.betcha.co.nz/v2/alerts/List`
- `status-api.production.betcha.co.nz/index.json`
- `api.trafficguard.ai/.../validate/event`

## Immediate AUTOBET extraction targets

1. `gql/router` operations that resolve event/market/selection IDs
2. `v2/racing/meeting` + `rest/v1/racing/` for live race and runner mapping
3. account checks via `v2/client/Balance` + `v2/client/get`
4. exact request emitted when odds/add-to-betslip/place-bet actions fire

## Notes

- This map is observational from browser traffic, not official vendor documentation.
- Endpoint naming and route shape suggest BETCHA and TAB share a similar platform architecture with different hostnames.
