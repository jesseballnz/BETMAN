# UI Click-through Regression Checklist — 2026-03-04 15:10 NZDT

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
- **8 / 8 checks passed**
- No blocking regressions detected in tested paths.

## Notes
- This checklist validates functional wiring and key behavior paths.
- A visual/manual browser UX pass can be added as a separate artifact if needed (tab-by-tab screenshots + interaction video).
