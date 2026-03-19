# BETMAN Launch Audit — 19 Mar 2026

## Status: **READY FOR LAUNCH**

All blocking items resolved. Remaining deferred items are post-launch scope.

---

## Completed Since MVP 1.2 (Mar 5)

### Security & Reliability
- [x] **Security hardening** — All HTTP responses include `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy` headers.
- [x] **Auth rate limiting** — 15 attempts per 15-minute window per IP.
- [x] **Session tokens** — `crypto.randomBytes(24)` entropy. CAPTCHA uses `crypto.randomInt()`.
- [x] **Password hashing** — bcrypt (fall-through to scrypt in environments without native bindings). No plaintext passwords stored or logged.
- [x] **Connection hygiene** — All frontend fetches use `fetchWithTimeout` (30s default). Polling loops guarded against stacking. DB pool: max 10 connections, 30s idle timeout.
- [x] **Foundation account protection** — `test@betman.co.nz` / `test1234` guardrail enforced.

### AI & Model Quality
- [x] **AI prompt tuning** — Removed `n/a` template abuse; GPT models no longer blank entire outputs when one field is missing.
- [x] **Selection context guard** — AI answers verified against requested runner names; fallback to deterministic explainer if LLM drifts.
- [x] **Race context guard** — Answers without meeting/race anchoring are rejected.
- [x] **AI answer logging** — Bakeoff JSONL stores up to 2000 chars of model answer per run for quality review.
- [x] **Bakeoff enrichment** — 8 real-world test cases (RW1–RW8) with context payloads and `mustInclude` scoring across: race analysis, PASS discipline, multi building, stake/risk, market movers, contradiction handling, decision format, fast-brief.
- [x] **Auto-tune weights** — Phase 2 dynamic ensemble weights computed from leaderboard composite scores and surfaced in the Bakeoff tab.

### UX / Frontend
- [x] **ROI fix** — `fmtRoi` correctly signs and formats values; performance tab ROI columns render cleanly.
- [x] **Bankroll tab** — Kelly fraction selector (conservative/moderate/aggressive), daily allocation cap, live bet plan table.
- [x] **Flicker fix** — Loading placeholder only shown when table is empty; existing data never cleared on refresh.
- [x] **Mobile audit (Mar 14)** — Filter toolbar flex-wrap, analysis table scroll wrapper, section-head stacking on <640px.
- [x] **Light mode** — Full light-mode palette via `body[data-theme="light"]` CSS tokens.
- [x] **Help tab** — Covers all tabs: Workspace, Suggested, Multis, Market Movers, Interesting Runners, Bet Plans, Strategy, Bankroll, Performance, Model Bakeoff. Includes AI Chat mode guide, signal reading, account management, and troubleshooting.

### Infrastructure
- [x] **`/api/version` endpoint** — Returns `{ ok, version, build, service, ts }` at `GET /api/version`.
- [x] **SCRIPTS.md** — Full reference of all scripts, npm commands, environment variables.
- [x] **Build stamp** — `BETMAN_BUILD` updated in `frontend/app.js`; `BETMAN_SERVER_VERSION` and `BETMAN_SERVER_BUILD` constants in `frontend_server.js`.

---

## Test Suite Status

Executed 2026-03-19:

```
$ npm test
Consistency harness passed.
status_writer tests passed
mvp1.1 audit tests passed
ai_chat scenarios tests passed
select_filters tests passed
model_profile_context tests passed
ai_analyse tests passed
ai_live_chat_smoke tests passed
bakeoff_ui tests passed
meeting_search tests passed
perf-utils tests passed
```

All 11 test suites passing.

---

## API Surface

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | Auth | Service health, uptime, AI status, DB flag |
| `GET /api/version` | Auth | Version and build info |
| `GET /api/status` | Public | Current suggested bets, race list, market movers |
| `GET /api/races` | Public | Race list with runner odds |
| `GET /api/suggested-bets` | Public | Model-led win/exotic suggestions |
| `GET /api/interesting-runners` | Public | Notable profiles |
| `GET /api/ai-models` | Auth | Available AI models for UI selector |
| `POST /api/ask-selection` | Auth | AI race analysis request |
| `GET /api/bankroll` | Auth | Bankroll state + Kelly bet plan |
| `POST /api/bankroll` | Auth | Set bankroll and risk profile |
| `GET /api/model-bakeoff/latest` | Admin | Latest bakeoff leaderboard |
| `POST /api/bakeoff-run` | Admin | Trigger live bakeoff run |
| `GET /api/auth-users` | Admin | User list management |
| `POST /api/auth-users` | Admin | Create user |
| `POST /api/auth-users/password` | Admin | Reset user password |
| `POST /api/auth-users/delete` | Admin | Delete user |
| `POST /api/auth-self-password` | Auth | Self-service password change |
| `GET /api/pricing` | Public | Stripe pricing links |
| `GET /api/performance-poll` | Admin | Trigger performance data refresh |

---

## Post-Launch Backlog

These items are explicitly deferred to the next sprint:

- **SportR upgrade** — Sportr model pipeline and live odds improvements.
- **Cross-app linking** — Deep link between BETMAN and Sportr dashboards.
- **Telegram integration** — Push alerts for qualifying signals to Telegram.
- **Auto-Bet executor** — TAB/Betcha credential integration for automated bet placement.
- **Race cards mobile UX** — Wider tap targets and per-card padding at ~360px.
- **AI Chat bottom-sheet** — Convert to bottom-sheet with dismiss handle on <600px viewports.
- **Value board labels** — Inject metric labels in single-column mode.

---

## Sign-off

BETMAN is production-ready for external tester onboarding under the "1.0" label.
All blocking security, reliability, UX, and AI quality items have been addressed.
