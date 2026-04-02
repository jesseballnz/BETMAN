# BETMAN tenant Pulse operator note — acct_test-betman-co-nz

- Tenant auth/session routing works locally using `test@betman.co.nz` / existing seeded account.
- Root cause of stale tenant Pulse/status was **missing tenant-scoped status writer execution**, not auth scoping.
- Evidence:
  - Before refresh, tenant `status.json` / `alerts_feed.json` were stale while default/global equivalents were fresh.
  - After `TENANT_ID=acct_test-betman-co-nz node scripts/status_writer.js`, tenant files refreshed on disk.
  - Authenticated local API probe returned tenant status successfully and tenant Pulse feed successfully.
- Live alerts remain empty after refresh because the regenerated tenant Pulse feed itself is empty (`alerts: []`). This narrows the blocker to **no current qualifying Pulse signals** under current generation rules/config, not read-path failure.
- Remaining signoff gap: automated proof script still skips authenticated live proof unless `BETMAN_PROOF_USERNAME` / `BETMAN_PROOF_PASSWORD` are exported for the proof run.
