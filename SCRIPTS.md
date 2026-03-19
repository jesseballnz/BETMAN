# BETMAN Scripts Reference

## Core Server

| Command | Script | Description |
|---|---|---|
| `node scripts/frontend_server.js` | `scripts/frontend_server.js` | Main HTTP server — serves frontend and all `/api/*` endpoints |

## Data Pipeline

| Command | Script | Description |
|---|---|---|
| `node scripts/racing_poller.js` | `scripts/racing_poller.js` | Poll TAB/racing APIs, generate suggested bets and bet plans |
| `node scripts/race_cache_writer.js` | `scripts/race_cache_writer.js` | Write race list cache to `frontend/data/races.json` |
| `node scripts/status_writer.js` | `scripts/status_writer.js` | Aggregate status payload to `frontend/data/status.json` |

## npm Scripts

| Command | Description |
|---|---|
| `npm test` | Full test suite (consistency harness + all unit/integration tests) |
| `npm run bakeoff` | Full AI model bakeoff across all configured models and prompts |
| `npm run bakeoff:quick` | Quick bakeoff (4 prompts × 1 run, for CI/sanity checks) |
| `npm run models:test` | Model sanity test against live `/api/ask-selection` |
| `npm run jobs:once` | Single cycle of data pipeline jobs |
| `npm run jobs:run` | Continuous data pipeline loop |
| `npm run consistency:check` | Run frontend consistency harness only |

## Utility Scripts

| Script | Description |
|---|---|
| `scripts/bookmaker_status.js` | Check TAB / Betcha bookmaker connection status |
| `scripts/info_pooler.js` | Pool meeting intelligence across sources |
| `scripts/meeting_profile.js` | Build a meeting profile from cached race data |
| `scripts/model_sanity_test.js` | Quick model sanity test (single prompt per model) |
| `scripts/why_audit.js` | Audit WHY tag classification logic |
| `scripts/horse_learning_job.js` | Incremental horse learning / result ingestion |

## Shell Scripts

| Script | Description |
|---|---|
| `scripts/jobs_once.sh` | One-shot pipeline (poller → cache writer → status writer) |
| `scripts/jobs_runner.sh` | Continuous pipeline loop with 5-minute sleep between cycles |
| `scripts/adaptive_poller_loop.sh` | Adaptive polling loop (adjusts frequency based on race proximity) |
| `install.sh` | Bootstrap environment: npm install, memory dirs, env checks |

## Python / ML Scripts

| Script | Description |
|---|---|
| `scripts/betman_train_offline.py` | Offline model training from historical bet results |
| `scripts/betman_calibrate_probs.py` | Calibrate win probability outputs against historical data |
| `scripts/roi_optimizer.py` | Optimise Kelly fraction and staking parameters for ROI |
| `scripts/success_tracker.py` | Track and aggregate bet outcomes by model/meeting/race |
| `scripts/loveracing_miner.py` | Mine sectional and race data from LoveRacing feed |
| `scripts/loveracing_enrich.py` | Enrich race data with LoveRacing sectionals and form |

## Environment Variables

Key environment variables (see `.env` or `creds`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string for persistent storage |
| `OPENAI_API_KEY` | OpenAI API key for GPT models |
| `BETMAN_OLLAMA_BASE_URL` | Ollama base URL (default: `http://office.waihekewater.com:11434`) |
| `STRIPE_SECRET_KEY` | Stripe secret key for payment integration |
| `BETMAN_OPENAI_BUTTON_ENABLED` | Enable OpenAI model selection in UI (`true`/`false`) |
| `BETMAN_FAKE_AI` | Use fake AI responses in tests (`true`/`false`) |
