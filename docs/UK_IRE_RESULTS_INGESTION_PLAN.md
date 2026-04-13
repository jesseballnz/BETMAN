# UK / IRE verified group-race ingestion audit

## What exists already

The repo already has a generic TAB-affiliates result ingestion path that is close to usable for UK and Ireland:

- `scripts/racing_poller.js`
  - pulls meetings from `https://api.tab.co.nz/affiliates/v1/racing/meetings`
  - pulls event detail from `.../racing/events/:id`
  - persists raw event payloads under `data/tab/<date>/<country>/<meeting>/Rxx-<event-id>/event.json`
- `scripts/meeting_profile.js`
  - rebuilds winner pace/barrier profiles from `evt.data.results`
- `scripts/success_tracker.py`
  - already treats stored `event.json` files as the canonical result source for settlement analytics
  - reads `(data.tab...event.json).data.results` into a per-race `positions` map and optional dividends
- `scripts/tracked_bet_matching.js`
  - current race-result matching only needs `meeting`, `race`, `winner`, `position`, `settled_at`
- `frontend/data/settled_bets.json`
  - current settled row shape is simple and compatible with imported UK/IRE result rows

## Important repo gap

I did **not** find any existing UK/IRE-specific ingestion tool, docs, or group-race verifier.

Current runtime defaults are still hardcoded to `NZ,AUS,HK` in multiple places:

- `scripts/racing_poller.js`
- `scripts/jobs_once.sh`
- `scripts/jobs_runner.sh`
- `scripts/cron_racing_poller_runner.js`
- `scripts/cron_racing_runner_once.js`
- `scripts/cron_racing_runner_4ab294bf.js`
- `scripts/frontend_server.js`
- `scripts/tab_affiliates_pull.py`

## Key finding: TAB affiliates already serves UK and IRE

Live check against the existing source showed:

- `country=UK` returns meetings and event payloads
- `country=IRE` returns meetings and event payloads
- event payloads for final races include `data.results`
- UK and IRE event payloads look structurally compatible with the existing model

Observed sample:

- UK: Wolverhampton R1 returned `results=7`, `runners=8`
- IRE: Wexford R1 returned `results=8`, `runners=10`
- result row shape:
  - `position`
  - `name`
  - `barrier`
  - `runner_number`
  - `margin_length`
  - `entrant_id`

This means the fastest non-synthetic path is to reuse the current TAB event archive flow for UK/IRE results.

## Constraint: group-race verification is not in the current TAB shape

I checked TAB meeting/race payloads for UK/IRE and did not find a dependable populated `group` field in sampled meeting-level races.

So there are really two separate problems:

1. ingesting real UK/IRE race results
2. verifying that a race is a Group/Listed/Pattern target

Problem 1 is already nearly solved by the existing TAB flow.
Problem 2 needs an extra verification source.

## Recommended source options

### Option A, fastest practical path, recommended
Use **TAB affiliates as the raw replayable result source** and add a **pattern-race verifier sidecar**.

- Raw results: `api.tab.co.nz/affiliates/v1`
- UK verification source: BHA / Racing Admin pattern fixtures or official race programme pages
- IRE verification source: official HRI results / fixture pages

Why this is best:

- fits the repo with minimal code change
- reuses existing `event.json` archive format
- reuses `success_tracker.py` and settlement logic with almost no schema churn
- keeps result ingestion deterministic and replayable from stored event payloads

### Option B, more official but slower
Build separate country-specific scrapers/importers:

- UK from official BHA Racing Admin pages
- IRE from official HRI result pages

Why slower:

- new parsers
- new normalization path
- likely more brittle than current TAB event JSON
- UK official pages look less scrape-friendly than HRI

### Option C, fallback verification source
Use replayable public media/result pages for race-class tagging only, not as primary result storage.

Examples:

- HRI results pages for Ireland
- BHA Racing Admin pages for UK
- only if official pattern metadata cannot be obtained in a stable machine-readable way

## Concrete schema plan

Keep the current canonical race-result model centered on per-race finish positions and optional dividends.

### Canonical race result record

```json
{
  "source": "tab_affiliates",
  "source_country": "UK",
  "source_event_id": "uuid",
  "date": "2026-04-11",
  "meeting": "Wolverhampton",
  "race": "1",
  "race_name": "...",
  "race_status": "Final",
  "classification": {
    "jurisdiction": "UK",
    "is_group_race": true,
    "group_level": "G3",
    "is_listed": false,
    "verification_source": "bha_racing_admin",
    "verification_ref": "<url-or-id>",
    "verified_at": "2026-04-12T12:00:00Z"
  },
  "positions": [
    {
      "position": 1,
      "runner_name": "Sirius A",
      "runner_number": 3,
      "barrier": 2,
      "margin_length": 0,
      "entrant_id": "..."
    }
  ],
  "winner": "Sirius A",
  "dividends": {
    "quinella": null,
    "trifecta": null,
    "first4": null
  },
  "raw_path": "data/tab/2026-04-11/UK/wolverhampton/R01-.../event.json"
}
```

### Minimal settled-bet compatibility fields

The existing code only really requires:

- `meeting`
- `race`
- `winner`
- `positions[*].position`
- `positions[*].runner_name`
- `settled_at` or date context

So UK/IRE can slot in without redesigning `tracked_bet_matching.js`.

## Required implementation pieces

### 1. Expand country defaults
Change default polling and cron wiring from `NZ,AUS,HK` to include `UK,IRE` where desired.

Likely files:

- `scripts/racing_poller.js`
- `scripts/jobs_once.sh`
- `scripts/jobs_runner.sh`
- `scripts/cron_racing_poller_runner.js`
- `scripts/cron_racing_runner_once.js`
- `scripts/cron_racing_runner_4ab294bf.js`
- `scripts/frontend_server.js`
- `scripts/tab_affiliates_pull.py`

### 2. Add a pattern/group verification layer
Create a new normalizer, for example:

- `scripts/pattern_race_verifier.js`

Inputs:

- meeting name
- race number
- date
- country
- race title

Outputs:

- `is_group_race`
- `group_level`
- `is_listed`
- `verification_source`
- `verification_ref`

### 3. Add canonical export materialization
Create a repo-owned materialized file, for example:

- `frontend/data/race_results.json`
  or
- `memory/race_results/<date>.json`

Builder script could walk archived `data/tab/**/event.json` and emit normalized rows.

### 4. Preserve raw replayability
Do not discard the original `event.json` payloads.
They are the easiest audit trail and let success tracking rerun from source.

### 5. Group-race filtering
Only mark a race as verified-group when the sidecar verifier succeeds.
Do not infer group status from purse, venue, or name heuristics alone.

## Fastest end-to-end path

1. keep TAB affiliates as the primary UK/IRE result fetcher
2. enable `UK,IRE` in poll/archive jobs
3. add a verifier sidecar for Group/Listed status
4. materialize a normalized `race_results` export from archived event payloads
5. let existing settlement code continue using winner/position maps from archived events

## Bottom line

- Existing repo support for UK/IRE is **partial but real**
- There is **no dedicated UK/IRE ingestion implementation yet**
- The **fastest non-synthetic path** is **not** a brand new scraper
- It is to **reuse the current TAB-affiliates event archive path**, because it already returns real UK and IRE results in a compatible structure
- The missing piece is **verified group-race classification**, which should be added as a separate official verification layer rather than replacing the current result source
