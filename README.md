# BETMAN Operations

This README is operational guidance, not a release signoff.

## Core runtime

| Component | Command / Notes |
| --- | --- |
| Frontend/API server | `node scripts/frontend_server.js` |
| Poller runner | `bash scripts/jobs_runner.sh` or project-specific poller scripts under `scripts/` |
| Status builder | `node scripts/status_writer.js` |
| Public smoke | `node scripts/api_smoke_public.js` |
| Full test suite | `npm test` |

## Health surfaces
- Public health: `GET /api/health`
- Admin runtime health: `GET /api/runtime-health`
- Commercial API health: `GET /api/v1/health`

`/api/health` is now tied to the recorded public smoke state in `memory/api-smoke-public.json`.
If smoke evidence is missing, stale, or failing, the endpoint should not be treated as healthy.

## Start / stop
- Manual start: `./start_betman.sh`
- Manual stop: `./stop_betman.sh`
- Supervised macOS install: `./scripts/install_launchd_services.sh install`
- Supervision status: `./scripts/install_launchd_services.sh status`

## Runtime supervision status
Manual wrappers still exist and still use PID files only.
For actual crash/login restart on macOS, BETMAN now ships a repo-contained `launchd` install path.
See `docs/BETMAN_RUNTIME_SUPERVISION.md`.

Truthful current state:
- manual wrapper path: **not supervised**
- macOS `launchd` path: **supervised with KeepAlive + RunAtLoad**
- still no health-check-driven self-healing for stuck-but-not-dead processes

## Release governance
Before any tester/customer-facing release:
- use `docs/RELEASE_CHECKLIST.md`
- write a dated signoff record under `docs/release-signoffs/`
- keep README/docs claims tied to current evidence, not historic point-in-time runs
