# BETMAN Release Signoff Record — 2026-04-03

## Scope
Runtime/doc/release-governance correction pass focused on:
- finished-race status handling baseline
- public smoke freshness and public health truthfulness
- removing stale release claims from docs
- adding a real checklist/signoff trail

## Changes included
- Expanded finished-race status set to include `closed`, `finalized`, `settled`, `complete`, `completed`
- Aligned frontend client race-status filtering with server logic
- Marked public API smoke as `STALE` once older than the configured freshness window
- Changed `/api/health` to report real public-smoke state and return 503 when smoke is missing/stale/failing
- Replaced stale README assertions with operationally truthful guidance
- Added release checklist and this signoff record

## Commands run
- `npm test`
- `node scripts/api_smoke_public.js`
- `node tests/venue_inference.test.js`
- `node tests/status_writer.test.js`

## Result summary
- `npm test` now passes after the finished-race status alignment fix
- Public smoke script ran and refreshes `memory/api-smoke-public.json`
- Public health now reflects smoke freshness instead of always returning healthy

## Known gaps / waivers
- Restart supervision is still manual. `start_betman.sh` / `stop_betman.sh` manage PID files only; they do not provide crash restart, boot persistence, or watchdog behaviour.
- No real service manager definition was added in this pass. That means a process crash or reboot can still leave BETMAN offline until manually restarted.

## Release risk after this pass
- Moderate operational risk remains until supervised restart is implemented and tested.
- Smoke freshness depends on the smoke job actually being run on schedule; stale smoke will now surface correctly rather than masking the issue.

## Signoff
- Prepared by: OpenClaw subagent
- Approval required from: repo owner / release approver
- Status: ready for human review, not auto-approved
