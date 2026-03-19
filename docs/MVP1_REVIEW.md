# BETMAN MVP1 Review

Date: 2026-03-04

## Executive Summary

BETMAN is now in a strong MVP1 shape for a paid information product:
- Auth-gated UI/API (Basic Auth)
- Read-only public-facing data model (no balance/private internals on UI)
- Query API documented and functional
- Cleaner UX separation (Suggested / Multis / Interesting)
- Stake display logic now respects configured caps (with 120% strong-signal allowance)

## What Was Reviewed

### 1) Product scope alignment
- Removed bankroll/accounting optics from front-end (balance, daily P&L, open bets, transaction history)
- Repositioned around information delivery (signals, commentary, race/runners, suggested bets)

### 2) Betting signal presentation
- Clarified mismatch risk between model ranking and displayed recommendation:
  - `Model Rank #1`
  - `Recommended Bet`
  - explicit pick logic text
- Converted shorthand countdown text (`t-37.2m`) into plain English (`in 36 minutes`)

### 3) Risk/sizing logic
- Fixed over-cap display issue where suggested stake could exceed configured max
- Added controlled over-cap rule for strong signals:
  - Win bets up to 120% of configured max
  - Exotics still capped by exotic stake cap

### 4) API surface
- Added read-only endpoints:
  - `/api/health`
  - `/api/status`
  - `/api/races`
  - `/api/suggested-bets`
  - `/api/interesting-runners`
- Added docs:
  - `docs/BETMAN_API.md`
  - `docs/openapi.betman.yaml`

### 5) Frontend UX/UI
- Added dedicated sections/tabs and cleaner separation:
  - Suggested Bets
  - Multis
  - Interesting Runners
- Added WHY filter for bettor context
- Upgraded visual polish:
  - boxed topbar
  - bordered section containers
  - improved spacing and row hover states

### 6) Reliability checks
- Syntax checks passed for key runtime JS files
- Unit test suite identified stale expectation and was updated for current balance aggregation logic

## MVP1 Acceptance Checklist

- [x] Paid-info mode UI (no account balance dependence in front-end)
- [x] Read-only query API available
- [x] Authentication in front
- [x] Suggested stakes obey configured risk caps
- [x] Multi display isolated from standard suggestions
- [x] Human-readable timing text
- [x] Basic docs for internal/external handoff

## Recommended Next (MVP1.1)

1. Replace Basic Auth with tokenized API keys + per-client revocation
2. Add request logging + rate limit controls for paid API usage
3. Add API response versioning (`/api/v1/...`)
4. Add lightweight smoke monitor for stale poll timestamps
5. Add e2e front-end smoke test (tabs, filters, API auth flow)

---

Status: **MVP1 ready**
