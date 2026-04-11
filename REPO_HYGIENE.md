# BETMAN repo hygiene notes

This repo mixes real code with some intentionally tracked runtime-derived JSON.
Do not assume every changing data file should be ignored.

## Intentionally tracked or review-before-ignore areas
- `data/meeting_profiles/today/`
- `frontend/data/alerts_feed.json`
- `frontend/data/alerts_history.json`
- `frontend/data/betman_prob_calibration.json`
- `frontend/data/settled_bets.json`
- `frontend/data/tracked_bets.json`
- other `frontend/data/*.json` files already committed historically

These appear to be part of the app's operating surface, not just disposable logs.
Any move to untrack them should be deliberate and coordinated.

## Safe local-only ignores added
- `*.pid`
- `.cron_logs/`
- `.cron_runs/`
- `logs/`
- `tmp_*.js`
- `tmp_*.py`
- `tmp_*.sh`

## Push discipline
- Review `git status` before every push.
- Expect live data changes to appear.
- Do not blindly `git add -A`.
- Stage code changes file-by-file.
