# UI Click-through Regression Checklist — 2026-03-04 15:10 NZDT

> Historical artifact only. This file records a dated regression pass and must not be used as a current release signoff.

## Scope
Smoke + logic checks for BETMAN MVP UI/API interactions after recent changes.

## Results

1. Server health (`/api/health`) — **PASS**
2. Auth config read (`/api/auth-config`) — **PASS**
3. Status payload shape (`/api/status`) — **PASS**
4. Suggested bets non-empty (`/api/suggested-bets`) — **PASS**
5. Interesting runners ETA format (`in Xm` / `jumped`) — **PASS**
6. Chat single-race context anchoring (R3 test payload) — **PASS**
7. Chat multi request routing (clarify/ai/fallback) — **PASS**
8. Critical UI elements present in HTML (filters/chat/auth modal/tabs) — **PASS**

## Summary
- **8 / 8 checks passed on 2026-03-04**
- No blocking regressions were detected in the tested paths at that time.

## Notes
- This checklist validates functional wiring and key behavior paths for that date only.
- A visual/manual browser UX pass can be added as a separate artifact if needed (tab-by-tab screenshots + interaction video).
- Current releases should instead use `docs/RELEASE_CHECKLIST.md` plus a dated file under `docs/release-signoffs/`.
