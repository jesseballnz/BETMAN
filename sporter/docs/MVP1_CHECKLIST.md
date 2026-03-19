# Sportr MVP1 Checklist

| Area | Status | Notes |
| --- | --- | --- |
| Live feed ingestion | ✅ | `scripts/live_poll_loop.js` runs `run_market_pipeline` on a fixed cadence and writes health to `memory/poll_state.json`. Switch env vars to real DraftKings/FanDuel/TAB endpoints when ready. |
| Model overlays | ⏳ | TODO: ingest spread/total model % and attach to `market_snapshot.json` (edge board should show model delta, not just consensus delta). |
| Alerting | ⏳ | TODO: configurable thresholds + Slack/Signal/webhook pushes, plus UI badges/log. |
| AI panel port | ⏳ | TODO: lift BETMAN AI chat/basket into Sportr once model outputs are present. |
| Auth & roles | ⏳ | Optional for MVP1 if single-user; otherwise mirror BETMAN admin modal. |
