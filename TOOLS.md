# TOOLS.md - Local Notes

This machine operates as The Ball Capital Office.

Primary function: Capital deployment across crypto + racing.

No credentials are stored here.
Secrets live in: ~/.openclaw/secrets/

---

## Betting Platforms

### TAB (New Zealand)

- Alias: tab-nz
- Interface: Web (automation via Playwright)
- Base URL: https://www.tab.co.nz/
- Mode: Read-only default
- Live deployment requires: CAPITAL_LIVE_TRADING=true

Supported actions:
- tab_login
- tab_balance
- tab_open_bets
- tab_place_bet (guarded)
- tab_cancel_bet (guarded)

---

### Betcha

- Alias: betcha-nz
- Interface: Web (automation via Playwright)
- Base URL: https://www.betcha.co.nz/
- Mode: Read-only default
- Live deployment requires: CAPITAL_LIVE_TRADING=true

Supported actions:
- betcha_login
- betcha_balance
- betcha_open_bets
- betcha_place_bet (guarded)

---

## Capital Controls

- Default mode: Simulation
- Live trading toggle:
ENV: CAPITAL_LIVE_TRADING=true
- Daily max exposure: Defined in capital config
- Max single wager %: Defined in capital config
- Hard stop drawdown: Defined in capital config

No bet is placed without:
1. Edge calculation
2. Stake sizing logic
3. Confirmation gate (if live)

---

## Crypto

Exchanges:
- (to define)

Supported actions:
- fetch_balances
- fetch_open_positions
- place_order (guarded)
- cancel_order
- fetch_orderbook
- volatility_scan

Key information on horses. Gather as much data about the horses from here as possible.
This includes secionals and other key data that is not available from TAB or Betcha.
https://loveracing.nz/Home.aspx

Risk rules:
- No full-Kelly sizing
- Position sizing capped per asset
- Exposure capped per regime

---

## Local Infrastructure

Machine: Thor (Intel iMac)
Primary Model: prod-fast:latest (Ollama local)
Gateway: local mode
Port: 18789

---

## Logging

All external actions logged locally.
No credentials logged.
No passwords printed.
No raw tokens exposed.

---

This file defines operational plumbing.
It does not define strategy.
It does not store secrets.
