# Sportr

Sportr is the standalone sports betting intelligence workspace for multi-sport markets. It mirrors the disciplined workflow of BETMAN but runs from its own application root with independent data, frontend assets, and server code.

## Key Goals

- Unified dashboard for live and upcoming fixtures across leagues (NFL, NBA, EPL, etc.).
- Market-move + model-signal tracking similar to BETMAN, but tuned for head-to-head, spreads, totals, and props.
- Zero runtime dependency on the BETMAN codebase. All code, assets, data files, and runtime state live under the `sporter/` root.

## Project Layout

```
sporter/
  frontend/            # Standalone web client (static assets + JS app)
  data/                # Poller outputs, cached schedules, odds snapshots
  memory/              # Auth state, logs, tenant overlays (per Sportr)
  scripts/             # Sportr-specific backend services
  package.json         # Dependencies dedicated to Sportr
```

## Running the Dev Server

```
cd sporter
npm install
PORT=9080 node scripts/sporter_server.js
```

(`PORT` is optional – omit it to use the default 9080. `npm install` simply writes Sportr's own lockfile; there are no shared dependencies.) All data files resolve relative to the Sportr root, so you can run BETMAN and Sportr side-by-side without any shared paths.

## Data Pipeline

Run the pollers + modelling stack to refresh `data/books/*.json` and the consolidated `market_snapshot.json` used by the frontend:

```
cd sporter
node scripts/run_market_pipeline.js
```

Set `SPORTER_DRAFTKINGS_URL`, `SPORTER_FANDUEL_URL`, and `SPORTER_TAB_URL` if you want to hit real sportsbook feeds; the pollers fall back to `data/sample_feeds/*.json` when those env vars are unset.


## Continuous Poll Loop

Run the market pipeline on a fixed interval (default 60s) so /api/market stays fresh. The loop writes poll health to `memory/poll_state.json`.

```
npm run poll
```

Set `SPORTER_POLL_INTERVAL_MS` to adjust cadence.

## Tests

API smoke tests rebuild the feeds, start the HTTP server on a test port, and hit `/api/health`, `/api/schedule`, and `/api/market` (verifying UFC props + edges) so we can prove data is flowing.

```
npm test
```

## Next Steps

- Flesh out real pollers for sportsbook APIs (DraftKings, FanDuel, TAB Sports).
- Build model pipelines for spread / total projections.
- Add user auth + multi-tenant overlays similar to BETMAN once Sportr core is stable.
