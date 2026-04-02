# BETMAN Pulse live-proof record — 2026-04-03

## Scope
Close the remaining parity gap between checked-in BETMAN behavior and the currently supervised localhost instance.

Artifacts:
- `docs/release-signoffs/artifacts/2026-04-03-pulse-live-proof.json`

## Root cause closed here
The earlier `401 auth_required` result for unauthenticated `GET /api/health` was **not** caused by a stale supervised process.
It was a source bug in `scripts/frontend_server.js`:
- a public `/api/health` branch existed,
- but it was placed **after** a blanket `if (!requireAuth(req, res)) return;` gate,
- so the public branch was dead code and unreachable.

That ordering bug is now fixed.

## Commands run
- `node --check scripts/frontend_server.js`
- `node tests/pulse_release_evidence.test.js`
- `node tests/alerts_generation.test.js`
- `TENANT_ID=acct_test-betman-co-nz node scripts/status_writer.js --state_path=memory/racing-poll-state.json`
- `./scripts/install_launchd_services.sh install`
- `curl -i http://127.0.0.1:8080/api/health`
- `BETMAN_PROOF_USERNAME='test@betman.co.nz' BETMAN_PROOF_PASSWORD='test1234' node scripts/pulse_live_proof.js docs/release-signoffs/artifacts/2026-04-03-pulse-live-proof.json`

## What is now proven
- Deterministic Pulse release evidence still passes.
- The supervised BETMAN server was restarted from current repo source via launchd.
- Unauthenticated `GET /api/health` now returns **200** with the expected public smoke-backed payload.
- Authenticated Pulse endpoints are reachable on the live instance:
  - `/api/v1/pulse-config` → 200
  - `/api/v1/alerts-feed` → 200
  - `/api/v1/alerts-history` → 200
- Tenant runtime artifacts for `acct_test-betman-co-nz` were refreshed:
  - tenant `status.json` now matches current default runtime freshness
  - tenant `alerts_feed.json` / `alerts_history.json` were regenerated

## What the regenerated artifact shows
- public health parity: **verified**
- tenant status freshness: **verified refreshed**
- tenant pulse feed observability: **verified reachable**
- positive live pulse signal evidence: **not observed at probe time**
  - live tenant alerts count remained `0`

## Assessment
This closes the deployed-instance parity blocker for:
- `/api/health` public behavior
- supervised runtime using current checked-in server code
- tenant runtime artifact freshness for the test tenant

This does **not** prove that live Pulse had a qualifying alert at probe time.
It only proves the endpoint and tenant artifacts were current and observable.

## Signoff status
- Status: parity gap closed; no positive live pulse alert observed
- Prepared by: OpenClaw subagent
- Human review required: yes
