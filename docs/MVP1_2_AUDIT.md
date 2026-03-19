# BETMAN MVP 1.2 Audit — 2026-03-05

We have iterated through the outstanding UI/content polish, mobile clean-up, favicon/touch icons, and AI chat context enforcement so external testers get the same disciplined experience as the internal crew.

## Scope Covered
1. **Public marketing surfaces**
   - `/landing` + `/why` now share the same header template, black backgrounds, BETMAN green (#B6FF00) palette, clickable full-resolution screenshots, and a horse-race hero on the login page.
   - All marketing assets (`/assets/**`, `/favicon.ico`, `/apple-touch-icon*.png`) are served pre-auth and verified after cache-busting.
2. **Onboarding + auth flows**
   - Login CTA text updated, Why BETMAN link spacing corrected, password setup guidance consistent.
   - BETMAN tester CTA pulls Stripe tester link dynamically; marketing copy hooked to live `/api/pricing` fallback.
3. **Data refresh & heartbeat plumbing**
   - Heartbeat loop continues to run `racing_poller.js`, `race_cache_writer.js`, and `status_writer.js` so portal data stays live.
4. **Portal UX**
   - Analysis table no longer shows "Missing" placeholder rows; AI Analyse button uses flat BETMAN green fill.
   - Main workspace header reorganised (API status now sits with Last Update) to save topbar space.
5. **AI Chat discipline**
   - Added selection-context filtering. AI answers that drift to other runners are rejected and we fall back to the deterministic explainer.

## Automated Test Suite
```
$ npm test
status_writer tests passed
mvp1.1 audit tests passed
```
(Executed 2026-03-05 15:50 NZDT.)

## Manual Checks
- `/landing`, `/why`, `/assets/**`, `/favicon.ico`, `/apple-touch-icon*.png` validated via browser + curl with no auth challenge.
- Login hero + new typography confirmed responsive (≤640px viewport) after CSS cache bump (`styles.css?v=20260305-0044`).
- AI Chat inspected with dragged selections — fallback kicks in if LLM output omits requested runners.
- Portal header pills now wrap cleanly on narrow widths.

## Readiness
With branding, assets, AI chat filter, and MVP1.1 audits currently green, BETMAN is ready for external tester onboarding under the "MVP 1.2" label.
