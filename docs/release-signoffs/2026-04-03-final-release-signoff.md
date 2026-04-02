# BETMAN Final Release Signoff — 2026-04-03

> Superseded for post-cutover decisioning by `docs/release-signoffs/2026-04-03-post-cutover-release-addendum.md`.

Status: **CONTROLLED RELEASE SUPPORTED**  
Decision owner: **repo owner / release approver**  
Prepared by: **OpenClaw subagent**

This is the operator-grade release signoff for the current BETMAN repo state after the latest fixes in Pulse targeting/evidence, tracked-bet settlement handling, and runtime/docs truthfulness.

## 1) Release decision rubric

### Full go
Use only if all of the following are true:
- full regression suite rerun successfully (`npm test`)
- public smoke rerun successfully close to release time
- manual UI spot-check completed on changed surfaces
- start/stop flow verified on the intended host
- no unreviewed release-critical data or fixture churn remains in the working tree
- known runtime limitations are accepted by the approver

### Controlled release
Use if core release-critical checks pass, but one or more non-fatal operational gaps remain with explicit operator awareness.
Typical examples:
- shell-wrapper runtime without real crash/boot supervision
- targeted regression evidence is good, but not every broad smoke was rerun in the same signoff pass
- unrelated data churn is present but intentionally excluded from release scope

### No-go
Use if any of the following are true:
- release-critical tests fail
- public health/smoke evidence is missing, stale, or failing
- tracked data or Pulse scope leaks outside intended targeting
- docs/runtime claims overstate current behaviour
- rollback/start/stop path is unknown

## 2) Scope signed off here

### Included fix areas
- **Pulse targeting and release evidence**
  - targeted Pulse alerts can be scoped by country / meeting / race
  - deterministic release evidence added via `tests/pulse_release_evidence.test.js`
  - shortcut release check added via `scripts/release_check_pulse.sh`
  - package script updated with `release:check:pulse`
- **Tracked bet settlement truthfulness**
  - tracked win bets now settle correctly from winner-only race result rows, including losing outcomes
  - coverage added in `tests/tracked_bet_matching.test.js`
  - API coverage added in `tests/betman_api.test.js`
- **Runtime/docs governance**
  - README/docs no longer present stale release claims as current truth
  - `/api/health` contract documented as smoke-backed rather than always healthy
  - evergreen release checklist and dated signoff trail added
- **Race status alignment**
  - client finished-race handling now matches expanded server-side finished states

### Explicitly excluded from this signoff
- mutable day-of-racing data churn under `data/meeting_profiles/today/`
- generated frontend tenant/feed data under `frontend/data/`
- any claim that BETMAN now has real supervised restart behaviour

## 3) Evidence gathered in this pass

## Commands run
- `bash scripts/release_check_pulse.sh`
- `node tests/tracked_bet_matching.test.js`
- `node tests/betman_api.test.js`
- path existence check for:
  - `docs/RELEASE_CHECKLIST.md`
  - `docs/release-signoffs/2026-04-03-runtime-docs-governance.md`
  - `tests/pulse_release_evidence.test.js`
  - `scripts/release_check_pulse.sh`
  - `memory/api-smoke-public.json`
  - `start_betman.sh`
  - `stop_betman.sh`
  - `scripts/frontend_server.js`
  - `scripts/status_writer.js`
  - `tests/alerts_generation.test.js`

## Observed results
- `bash scripts/release_check_pulse.sh` → **PASS**
  - deterministic Pulse release evidence test passed
  - existing Pulse generation regression test passed
- `node tests/tracked_bet_matching.test.js` → **PASS**
  - winner-only losing tracked win bet settlement now covered and passing
- `node tests/betman_api.test.js` → **PASS**
  - tracked-bets API fallback/settlement coverage passing
  - Pulse config route persistence/filtering coverage passing
  - health/auth/basic API contract tests passing
- `memory/api-smoke-public.json` exists with `checkedAt: 2026-04-02T21:26:07.787Z`
  - artifact present
  - artifact is fresh relative to this signoff window
  - recorded public smoke results are acceptable for current contract (`/insights/sync` 415 treated as expected)

## Referenced paths verified present
- `docs/RELEASE_CHECKLIST.md`
- `docs/release-signoffs/2026-04-03-runtime-docs-governance.md`
- `tests/pulse_release_evidence.test.js`
- `scripts/release_check_pulse.sh`
- `memory/api-smoke-public.json`
- `start_betman.sh`
- `stop_betman.sh`
- `scripts/frontend_server.js`
- `scripts/status_writer.js`
- `tests/alerts_generation.test.js`

## 4) Gate-by-gate signoff

### Gate A — Release-critical regression evidence
Status: **PASS**
- Pulse targeting evidence is deterministic and passing
- tracked bet settlement regression coverage is passing
- API-level regression coverage for affected areas is passing

### Gate B — Runtime truthfulness
Status: **PASS**
Evidence:
- `README.md`
- `docs/BETMAN_API.md`
- `docs/openapi.betman.yaml`
- `docs/RELEASE_CHECKLIST.md`
- `docs/release-signoffs/2026-04-03-runtime-docs-governance.md`

Assessment:
- current docs now describe smoke-backed health truthfully
- restart supervision is explicitly described as manual / unsupervised
- old dated UI checklist is no longer implicitly treated as evergreen release signoff

### Gate C — Health evidence present
Status: **PASS**
Evidence:
- `memory/api-smoke-public.json` present and fresh in this signoff window

Caveat:
- this signoff confirms artifact presence/freshness; it does **not** rerun the public smoke inside this exact pass

### Gate D — Start/stop/rollback operability
Status: **PARTIAL / WAIVED FOR CONTROLLED RELEASE**
Evidence:
- `start_betman.sh` exists
- `stop_betman.sh` exists
- README documents the limitation accurately

Gap:
- no real process supervisor
- crash restart and boot persistence are not guaranteed
- stale PID/operator intervention risk remains

Owner / next action:
- Owner: repo owner / operator
- Next action: add and verify a real service manager definition before claiming full-go runtime resilience

### Gate E — Working tree hygiene
Status: **PARTIAL / WAIVED FOR CONTROLLED RELEASE**
Evidence:
- current working tree includes unrelated mutable data churn (`data/meeting_profiles/today/*`, `frontend/data/*`)
- release-relevant code/doc/test changes are separable from that churn

Risk:
- operator can accidentally over-sign broad working tree state if scope is not kept explicit

Owner / next action:
- Owner: release approver
- Next action: exclude or isolate mutable fixture/data churn before any formal tagged release or external packaging

### Gate F — Full regression rerun
Status: **NOT COMPLETE IN THIS PASS**
Evidence:
- targeted release-critical checks passed
- `package.json` includes `npm test` coverage for the new Pulse release evidence test

Gap:
- full `npm test` was not rerun in this subagent pass

Owner / next action:
- Owner: release approver / operator
- Next action: run `npm test` on the intended release host before upgrading decision from controlled release to full go

## 5) Remaining known risks
- **Operational supervision risk**: current start/stop wrappers are not a real supervisor.
- **Broad-suite confidence gap**: targeted release checks passed, but full-suite rerun is still outstanding in this pass.
- **Working-tree noise risk**: mutable data/feed churn is mixed into the repo state and should not be mistaken for audited release scope.

## 6) Release recommendation

## Recommended decision
**CONTROLLED RELEASE**

## Why this is not full go
- no verified process supervisor
- no fresh full-suite rerun in this exact signoff pass
- unrelated mutable data churn remains in the working tree

## Why this is not no-go
- the release-critical fixes under review have direct, passing regression evidence
- tracked bet settlement issue is covered at logic and API layers
- Pulse targeting/scope evidence is deterministic and passing
- docs/runtime claims now align with actual behaviour
- public smoke artifact exists and is fresh

## 7) Operator checklist before pushing beyond controlled release
- [ ] run `npm test`
- [ ] run `node scripts/api_smoke_public.js`
- [ ] verify `/api/health` on the intended host after smoke refresh
- [ ] perform manual UI spot-check on Pulse and tracked bets surfaces
- [ ] isolate or intentionally exclude mutable data churn from the release unit
- [ ] add a real supervisor/service definition if claiming durable runtime

## 8) Approval block
- Approver: ____________________
- Decision taken: **Full go / Controlled release / No-go**
- Date/time: ____________________
- Notes / waivers / expiry: ____________________
