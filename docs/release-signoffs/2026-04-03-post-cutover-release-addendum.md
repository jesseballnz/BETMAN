# BETMAN Post-Cutover Release Addendum — 2026-04-03

Status: **NO-GO**  
Decision owner: **repo owner / release approver**  
Prepared by: **OpenClaw subagent**

Supersedes the earlier same-day "controlled release supported" posture in `docs/release-signoffs/2026-04-03-final-release-signoff.md` for the currently deployed local cutover state.

## Executive decision

The current BETMAN repo/runtime combination is **not ready to be upgraded from controlled release to full release**, and on the evidence captured in this pass the correct decision is now **NO-GO**.

Why:
1. **Deployed runtime parity is not proven and appears wrong**.
   - Live localhost probe returned `401 auth_required` for `GET /api/health`.
   - Current checked-in source at `scripts/frontend_server.js:5693` serves `/api/health` as a public endpoint.
   - That is a direct mismatch between observed runtime behaviour and checked-in source expectations.
2. **Pulse release evidence is unstable in this pass**.
   - `node tests/alerts_generation.test.js` passed when run directly.
   - `bash scripts/release_check_pulse.sh` failed in the same pass because that same regression test asserted `expected live alerts for meaningful untracked movers`.
   - A release gate that passes and fails back-to-back is not reliable release evidence.
3. **Live tenant Pulse proof remains incomplete / stale**.
   - Default runtime files refreshed around `2026-04-03T10:43:17Z`.
   - Tenant runtime files under `memory/tenants/acct_test-betman-co-nz/frontend-data/` were still last updated around `2026-04-02T11:16:01Z`.
   - No positive live tenant Pulse output was proven in this pass.

## Current local runtime state

### Repo revision checked
- `b54e817c12e760b83c8849c11ff373370acd4f10` (`b54e817`)

### Supervised runtime status
`launchd` supervision is now genuinely installed and active on this macOS host.

Observed via `./scripts/install_launchd_services.sh status`:
- `gui/501/nz.betman.server` → **running**
  - launcher: `scripts/betman_server_launcher.sh`
  - pid: `62367`
- `gui/501/nz.betman.poller` → **running**
  - launcher: `scripts/betman_poller_launcher.sh`
  - pid: `62373`

This clears the earlier "manual wrapper only" claim for this host. BETMAN **does** have active supervised runtime on the target machine.

### Important runtime caveats still observed
From local logs during this pass:
- `logs/launchd-server.err.log` shows repeated earlier restart attempts hitting `EADDRINUSE` on port `8080` before stabilising.
- `logs/launchd-poller.err.log` contains `node: command not found` entries from earlier poller launcher attempts.

Assessment:
- supervision exists and is active;
- recovery has been exercised implicitly;
- but the cutover is not clean enough to rely on supervision alone as signoff proof.

## Evidence gathered in this pass

### Commands run
- `./scripts/install_launchd_services.sh status`
- `bash scripts/release_check_pulse.sh`
- `node tests/alerts_generation.test.js`
- `node tests/betman_api.test.js`
- `node tests/tracked_bet_matching.test.js`
- `node scripts/pulse_live_proof.js docs/release-signoffs/artifacts/2026-04-03-pulse-live-proof.json`
- `curl -sS -D - http://127.0.0.1:8080/api/health`
- `lsof -nP -iTCP:8080 -sTCP:LISTEN`
- targeted reads of runtime logs and source/docs

### Results

#### 1) Supervision
- `./scripts/install_launchd_services.sh status` → **PASS**
- Both launch agents are loaded and running.

#### 2) Core API / tracked-bet regression
- `node tests/betman_api.test.js` → **PASS**
- `node tests/tracked_bet_matching.test.js` → **PASS**

#### 3) Pulse release gate
- `node tests/alerts_generation.test.js` → **PASS**
- `bash scripts/release_check_pulse.sh` → **FAIL**
  - deterministic Pulse evidence test passed;
  - existing Pulse generation regression then failed with:
    - `AssertionError [ERR_ASSERTION]: expected live alerts for meaningful untracked movers`

Assessment: Pulse release evidence is **flaky / unstable**, not cleanly green.

#### 4) Live deployed runtime probe
- `curl http://127.0.0.1:8080/api/health` returned:
  - HTTP `401 Unauthorized`
  - body: `{"ok":false,"error":"auth_required"}`
- Current source route in `scripts/frontend_server.js` expects `/api/health` to be public and return a structured health payload.

Assessment: current runtime is **not behaving like the checked-in source contract**.

#### 5) Live-proof artifact / freshness
Artifact path:
- `docs/release-signoffs/artifacts/2026-04-03-pulse-live-proof.json`

Additional local file freshness observed:
- `frontend/data/status.json` → `2026-04-03T10:43:17Z`
- `frontend/data/alerts_feed.json` → `2026-04-03T10:43:17Z`
- `memory/tenants/acct_test-betman-co-nz/frontend-data/status.json` → `2026-04-02T11:16:01Z`
- `memory/tenants/acct_test-betman-co-nz/frontend-data/alerts_feed.json` → `2026-04-02T11:16:01Z`

Assessment: default runtime is fresh; tenant-specific runtime evidence is stale.

## Gate-by-gate decision

### Gate A — Supervised runtime installed on target host
Status: **PASS**

Reason:
- launchd agents are installed and running now.

### Gate B — Release-critical regression evidence
Status: **FAIL**

Reason:
- Pulse release gate is not stable in this pass.
- A same-pass pass/fail split on the release check is disqualifying for release confidence.

### Gate C — Deployed runtime parity with source/docs
Status: **FAIL**

Reason:
- live `/api/health` behaviour does not match current source contract.

### Gate D — Positive live Pulse proof on deployed cutover
Status: **FAIL / NOT PROVEN**

Reason:
- no positive live tenant Pulse signal evidence captured;
- tenant runtime artifacts are stale relative to default runtime artifacts.

### Gate E — Remaining blockers explicit and bounded
Status: **PASS**

Reason:
- blockers are now specific and localised:
  1. fix or explain `/api/health` parity mismatch;
  2. stabilise `scripts/release_check_pulse.sh` / `tests/alerts_generation.test.js`;
  3. refresh and prove tenant Pulse data on the deployed runtime.

## Exact blockers to clear

1. **Health parity blocker**
   - Make the deployed `:8080` instance behave like current source for `/api/health`, or document and test the intended authenticated-only contract consistently across source, tests, and docs.

2. **Pulse release-check stability blocker**
   - Eliminate the flake in `tests/alerts_generation.test.js` / `scripts/release_check_pulse.sh` so the release gate is repeatably green.

3. **Tenant live-proof blocker**
   - Refresh tenant runtime data and capture live Pulse evidence against the actual deployed cutover instance, not just default runtime files.

## Decision

**NO-GO**

This is not a full-go because parity and live proof are missing.
This is not a controlled-release recommendation either, because there is an active release-gate instability plus a runtime/source contract mismatch on the deployed instance.

## Meeting-safe one-liner

**BETMAN has real launchd supervision on the host now, but the release is still NO-GO because the live cutover does not yet prove source parity and the Pulse release gate is currently unstable.**
