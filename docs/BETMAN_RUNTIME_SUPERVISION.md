# BETMAN Runtime Supervision

## Truth first

`./start_betman.sh` is still a manual convenience wrapper.
It uses `nohup` + PID files and does **not** guarantee restart after:
- process crashes
- host reboot
- user logout/login cycles
- stale PID file situations

That wrapper is fine for ad hoc local runs.
It is not durable supervision.

## Supported supervised path on this macOS host

BETMAN now includes a repo-contained macOS `launchd` install path.
This is the real restart/recovery path for this machine class.

### What it supervises

Two separate user agents:
- `nz.betman.server` → `scripts/betman_server_launcher.sh`
- `nz.betman.poller` → `scripts/betman_poller_launcher.sh`

Each agent is configured with:
- `RunAtLoad = true`
- `KeepAlive = true`
- `ThrottleInterval = 10`
- dedicated stdout/stderr log files under `logs/`

That means:
- BETMAN restarts after a crash
- BETMAN restarts after the user logs back in
- BETMAN no longer depends on fragile PID files for normal recovery

## Install

From repo root:

```bash
./scripts/install_launchd_services.sh install
```

## Check status

```bash
./scripts/install_launchd_services.sh status
```

## Uninstall / disable supervised services

```bash
./scripts/install_launchd_services.sh uninstall
```

## Write plist files only

```bash
./scripts/install_launchd_services.sh write
```

## Logs

Launchd logs:
- `logs/launchd-server.out.log`
- `logs/launchd-server.err.log`
- `logs/launchd-poller.out.log`
- `logs/launchd-poller.err.log`

Existing app logs remain in `logs/`.

## Launcher behaviour

The launchd agents run checked launcher scripts rather than raw inline commands:
- `scripts/betman_server_launcher.sh`
- `scripts/betman_poller_launcher.sh`
- shared env/bootstrap: `scripts/betman_env.sh`

These launchers:
- pin the working directory
- load `.env` when present
- create required runtime directories
- fail fast if `node` is missing

## Node server shutdown behaviour

`frontend_server.js` now:
- handles `SIGTERM`
- handles `SIGINT`
- logs `unhandledRejection`
- logs `uncaughtException`
- attempts graceful HTTP + Postgres pool shutdown before exit

This improves controlled restarts and makes crashes easier to diagnose.

## What still is not solved

This is materially better, but not magic.
Remaining gaps:
- if the process is healthy enough to stay alive but semantically stuck, `launchd` will not detect that by itself
- there is no external watchdog yet that probes `/api/health` and forces remediation on repeated failure
- launchd user agents restart after user login; if true headless boot is required without user session assumptions, a LaunchDaemon or another service model would be needed and should be reviewed separately

## Release claim allowed now

You may truthfully claim:
- BETMAN has a repo-contained macOS supervised runtime option using `launchd`
- BETMAN can auto-restart after crashes when installed via that path

Do **not** claim:
- universal cross-platform supervision
- health-check-based self-healing beyond process restart
- zero-touch recovery for every failure mode
