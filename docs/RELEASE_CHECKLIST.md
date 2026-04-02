# BETMAN Release Checklist

Use this before any tester/customer-facing release.

## 1) Scope and evidence
- [ ] Release scope written down (what changed, why, rollback path)
- [ ] `git status --short` reviewed
- [ ] Known unrelated data churn excluded from signoff
- [ ] Evidence artifacts saved under `memory/` or `docs/release-signoffs/`

## 2) Minimum checks
- [ ] `npm test`
- [ ] `node scripts/api_smoke_public.js`
- [ ] `bash tests/autobet_api_smoke.sh` against an intentionally started local instance if auth/autobet paths changed
- [ ] `/api/health` checked locally; result matches real smoke state
- [ ] Manual UI spot-check performed for changed surfaces

## 3) Runtime truthfulness
- [ ] README/docs updated to remove stale claims
- [ ] Any health endpoint claims match current behaviour
- [ ] Live deployed instance checked, not just source tree / fixture tests
- [ ] If smoke evidence is stale, release is blocked or explicitly waived
- [ ] If restart supervision is still manual, that gap is called out in the signoff
- [ ] If the running instance has not been restarted/reloaded since the relevant code change, deployment parity is unproven and release is blocked or explicitly waived

## 4) Runtime operations
- [ ] Start path verified (`./start_betman.sh`)
- [ ] Stop path verified (`./stop_betman.sh`)
- [ ] Logs checked for boot errors
- [ ] PID files match live processes if using the shell wrappers

## 5) Signoff
- [ ] Release record added in `docs/release-signoffs/`
- [ ] Signoff includes: commit/rev, commands run, pass/fail summary, known gaps, explicit approver
- [ ] If there are waivers, they are written down with owner + expiry

## Current known operational gaps
1. If BETMAN is run only via `start_betman.sh`, it is still just shell wrappers plus PID files. That is not durable restart supervision. A crash or reboot can leave the service down until someone restarts it.
2. A passing deterministic release test proves source behaviour, not deployed-instance parity. If the live process is still running an older build/config or older tenant data, release proof is incomplete until a live probe against the actual running instance is captured and attached.

For macOS hosts, BETMAN now has a real repo-contained `launchd` option via `./scripts/install_launchd_services.sh install`. Do not claim supervised auto-restart unless that service-manager path has actually been installed and verified on the target host.
