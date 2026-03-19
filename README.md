# BETMAN Ops Snapshot (Mar 8, 2026)

This repo now carries two live surfaces that are sharing traffic with test customers.

## 1. BETMAN (Racing stack)

| Component | Command / Notes |
| --- | --- |
| Poller loop | `node scripts/racing_poller.js` (plus `race_cache_writer` + `status_writer` every 5m; see `HEARTBEAT.md`) |
| Frontend server | `node scripts/frontend_server.js` (listens on 0.0.0.0 by default) |
| Data | `frontend/data/*.json`, `memory/racing-poll-state.json` |
| Tests | `npm test` (includes `status_writer`, `mvp1.1` audit, AI chat scenarios) |

### Current status
- Heartbeat automation is refreshing every ~5 minutes and logging to `memory/heartbeat-state.json`.
- Queue + exotic plans are surfacing cleanly (see heartbeat summaries).
- Latest regression run: `npm test` (all passing, Mar 8 @ 12:23 NZDT).

## 2. Sportr (Multi-sport stack)

| Component | Command / Notes |
| --- | --- |
| Pipeline | `cd sporter && node scripts/run_market_pipeline.js` (fetches live UFC card + sample cross-sport fixtures, regenerates books/schedule/models) |
| Poller loop | `cd sporter && nohup node scripts/live_poll_loop.js > memory/poll_loop.log 2>&1 &` (PID written to `memory/poll_loop.pid`) |
| API server | `cd sporter && PORT=9080 HOST=0.0.0.0 node scripts/sporter_server.js` |
| Data | `sporter/data/books/*.json`, `sporter/data/market_snapshot.json`, `sporter/data/sample-schedule.json`, `sporter/data/cache/` |

### Current status
- UFC markets are live via the ESPN scoreboard integration; other sports (NBA/NFL/EPL/NRL/AFL) remain template feeds for now but keep the filters populated.
- Bet window logic now auto-expands per sport so every filter shows markets immediately.
- Poller + API server are running (PID 34201 for the poll loop; server bound to 0.0.0.0).

## QA Checklist
- [x] `npm test`
- [x] Racing poller heartbeat healthy (every 5 min)
- [x] Sportr pipeline + poll loop restarted after latest code changes
- [x] Frontend bet-window fallback fixed (forces markets to show for all filters)

Everything above is what I’m signing off for external testers today. Ping me if you need deeper release notes or if we should bundle this into an internal changelog.
