# BETMAN Auth Route Audit — 2026-04-05

## Scope
- `scripts/frontend_server.js`
- `scripts/betman_api.js`
- `BETMAN_Mobile` auth client usage

## Summary
Auth posture improved after hardening:
- default admin password fallback removed
- Stripe secret file fallback removed
- unsigned webhook acceptance removed
- API query-string keys removed
- mobile login auth simplified to Bearer-only

## Route classes

### Public routes
Expected public access:
- `/api/health`
- `/api/pricing`
- `/api/password-setup-link`
- `/api/stripe-webhook` (signature-gated, not anonymous-trusting)
- `/login`, `/set-password`, static marketing pages

Risk notes:
- `password-setup-link` is intentionally public but should remain rate-limited in a future pass.
- `stripe-webhook` is public transport-wise but cryptographically authenticated by Stripe signature.

### Session/bootstrap routes
- `/api/login`
- `/api/logout`
- `/api/set-password` related flows

Risk notes:
- Login issues a server session and cookie with HttpOnly, SameSite=Lax, Secure when applicable.
- Bearer token handling currently reuses session ids, which is acceptable internally but should stay tightly scoped.

### Authenticated app routes
Representative protected routes in `frontend_server.js`:
- `/api/races`
- `/api/ask-betman`
- `/api/ask-selection`
- `/api/me`
- `/api/pulse-config`
- `/api/alerts-feed`
- `/api/tracked-bets`
- `/api/settled-bets`
- `/api/learnings-report`
- `/api/heatmap`

Expectation:
- must require `requireAuth(...)` or equivalent principal resolution before data return
- tenant resolution must remain principal-derived, never request-derived

### Commercial API v1 routes
In `scripts/betman_api.js`:
- `/api/v1/health` public
- most other `/api/v1/*` routes API-key/Bearer protected

Risk notes:
- query-string API key support has been removed
- health remains public by design

## Findings by auth mechanism

### Basic auth
- Still supported for some server-side/web test flows.
- Acceptable for controlled/internal use, but should not expand further.

### Session cookie
- Good flags in place.
- In-memory session store remains an operational weakness, not immediate auth bypass.

### Bearer
- Used for mobile login sessions and API-key alt path.
- Cleaner after cookie removal in mobile.

### API keys
- Header-based only now.
- Storage appears hashed, which is correct.

## Residual concerns
1. `frontend_server.js` is too large for easy auth invariants review.
2. Public account-recovery/setup endpoints need explicit rate-limiting.
3. In-memory sessions limit revocation and scaling guarantees.
4. Legacy plaintext password compatibility still exists for migration safety; should be removed after migration window.

## Recommended next auth steps
1. Add rate limiting to `/api/login` and `/api/password-setup-link`.
2. Add explicit route tests for every protected endpoint class.
3. Remove legacy plaintext password acceptance after migration.
4. Extract auth/session code into dedicated module.
