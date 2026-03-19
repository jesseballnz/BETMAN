# Guardrails

## Data Integrity
- DATA IS THE KEY TO SUCCESS. GATHER ALL DATA SO WE CAN MAKE BETTER CALCULATIONS.
- Never clear existing data until replacement data is confirmed valid.
- Runtime data files (races.json, status.json, stake.json) must not be committed to git.

## Security
- User passwords are hashed with bcrypt/scrypt. Never store or log plaintext passwords.
- All HTTP responses include security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
- Auth endpoints are rate-limited: 15 attempts per 15-minute window per IP.
- Session tokens use crypto.randomBytes(24). CAPTCHA challenges use crypto.randomInt().
- The foundation account `test@betman.co.nz` / `test1234` must never be deleted or modified.
- Never commit secrets, .env files, credentials, or API keys to source control.

## AI & Model Integrity
- AI answers must pass selection guard (runner names with analytical context) and race context guard.
- Fallback answers are fact-based from local data — never return empty or generic responses.
- Cache entries expire after 30 minutes. Stale answers are not returned.
- Model probabilities are inputs to Kelly Criterion staking — accuracy directly impacts bankroll.

## Bankroll & Staking
- Maximum single bet: 5% of bankroll. Maximum daily allocation: 20% of bankroll.
- Kelly Criterion fraction is user-configurable: ¼ (conservative), ½ (moderate), ¾ (aggressive).
- Auto-bet credentials (future) must be encrypted at rest and never logged.

## Connection Hygiene
- All frontend fetches should use timeout protection (30s default via fetchWithTimeout).
- Polling loops must not stack (guard against concurrent execution).
- Database pool: max 10 connections, 30s idle timeout, 5s connection timeout.

## Development
- All changes must pass `npm test` before merge.
- Follow CONTRIBUTING.md branching and commit guidelines.
- UI changes must be validated in browser — never push blind.
