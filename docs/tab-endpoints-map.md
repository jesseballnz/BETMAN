# TAB Endpoint Map (observed from live TAB web client)

Captured from runtime network resources on `www.tab.co.nz` (authenticated browser session), using `performance.getEntriesByType('resource')`.

Base hosts:
- `https://api.tab.co.nz`
- `https://www.tab.co.nz/api/providers/auth` (OIDC metadata)

## Observed API paths

- `/gql/router` (persisted GraphQL operations)
- `/insights/sync`
- `/insights/event`
- `/insights/error`
- `/v2/alerts/List`
- `/v2/client-notifications/get-client-checkin-preferences`
- `/v2/client-notifications/list`
- `/v2/client/Balance`
- `/v2/client/PendingBetCount`
- `/v2/client/TrackDevice`
- `/v2/client/client-details`
- `/v2/client/get`
- `/v2/client/max-deposit-allowed`
- `/v2/domain-featured/domain-featured-v2/ListQuickLinks`
- `/v2/event/market-rules`
- `/v2/finance/finance-v2/ListCreditCards`
- `/v2/finance/finance-v2/ListWithdrawalMethods`
- `/v2/metadata/GetByURL`
- `/v2/offers/ListCoupons`
- `/v2/racing/next-races-category-group`
- `/v2/racing/meeting`
- `/v2/racing/get-entrant-forms`
- `/v2/racing/FavouritesFromRaceIDs`
- `/v2/racing/RaceProductAvailability`
- `/rest/v1/racing/`
- `/v2/sport/event-query`
- `/v2/toolbox/ListExclusiveOddsEntrants`
- `/v2/toolbox/balances`
- `/v2/video/video-v2/ListChannels`
- `/v2/video/batchGet`
- `/v2/fixed-odd-exotic/get-exotic-odds`

## Phase 2: AUTOBET relevance classification

### Critical for market discovery / candidate resolution
- `/v2/racing/next-races-category-group`
- `/v2/event/market-rules`
- `/v2/sport/event-query`
- `/v2/toolbox/ListExclusiveOddsEntrants`
- `/gql/router` (persisted race/home queries, includes event/market context)

### Critical for account state / execution safety
- `/v2/client/Balance`
- `/v2/client/PendingBetCount`
- `/v2/client/client-details`
- `/v2/client/get`
- `/v2/toolbox/balances`

### Likely useful but not core to bet placement
- `/v2/client/max-deposit-allowed`
- `/v2/finance/finance-v2/ListCreditCards`
- `/v2/finance/finance-v2/ListWithdrawalMethods`
- `/v2/offers/ListCoupons`
- `/v2/video/video-v2/ListChannels`
- `/v2/domain-featured/domain-featured-v2/ListQuickLinks`
- `/v2/metadata/GetByURL`

### Non-core (telemetry / notifications)
- `/insights/sync`
- `/v2/client/TrackDevice`
- `/v2/client-notifications/list`
- `/v2/client-notifications/get-client-checkin-preferences`
- `/v2/alerts/List`

## Immediate AUTOBET extraction targets

If we are building a minimal TAB API-backed execution layer, prioritize instrumentation around:
1. `/gql/router` operations that resolve race/event + market + selection ids
2. `/v2/racing/next-races-category-group` for live race timing alignment
3. `/v2/client/Balance` + `/v2/client/PendingBetCount` for pre/post execution checks
4. Any request emitted when clicking odds/add-to-betslip/place-bet controls (to identify true placement endpoint)

## Notes

- `gql/router` uses persisted-query hashes via `extensions.persistedQuery.sha256Hash` and operation names (e.g., `HomeSportsScreen`, `HomepageNextToJumpRaces`).
- Most `/v2/*` endpoints appear cookie/session-authenticated.
- This map is observational (reverse-engineered from client traffic), not official vendor documentation.
