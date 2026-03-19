# Contributing to BETMAN

Thanks for contributing.

## Project Root
All development happens in this repository root (`BETMAN/`).

## Branching
- Branch from `main`
- Use short-lived feature branches
- Open PRs back to `main`

Suggested branch names:
- `feat/<topic>`
- `fix/<topic>`
- `chore/<topic>`

## Local Setup
```bash
npm install
```

## Required Checks Before PR
Run full test suite:
```bash
npm test
```

If you touch model logic or analysis UX, also run:
```bash
npm run models:test
npm run bakeoff:quick
```

## Runtime Jobs (No Cron)
Do **not** add cron dependencies for core runtime behavior.
Use:
```bash
npm run jobs:once   # one cycle
npm run jobs:run    # continuous
```

## Commit Guidelines
- Keep commits scoped and reversible
- Use imperative commit titles
- Include "why" in PR description

Example commit messages:
- `Fix strategy signal fallback when quantified inputs are missing`
- `Add bakeoff peer-score winner highlighting`

## Data / Secrets Rules
Never commit:
- `.env` files
- credentials / keys
- local runtime state under `memory/`
- generated bakeoff artifacts under `bakeoff/results/`

Follow `.gitignore` strictly.

## PR Checklist
- [ ] Tests pass locally (`npm test`)
- [ ] No secrets or local state in diff
- [ ] UI changes validated in browser
- [ ] If strategy/risk changed, verify no regressions in WIN/EW/exotics paths
- [ ] If model routing changed, verify free/paid lane behavior

## Release Notes
For production-impacting changes, include in PR body:
1. User-visible behavior change
2. Risk of regression
3. Rollback plan
