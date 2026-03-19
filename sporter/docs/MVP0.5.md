# Sportr MVP0.5 Snapshot

**Date:** 2026-03-08

## Scope Delivered

1. **Multi-book market consolidation**
   - DraftKings, FanDuel, and TAB Sports feeds normalized through the poller stack.
   - Snapshot builder now preserves up to eight props per book so downstream views can render actual prop markets, not just counts.
   - UFC data wired end-to-end alongside NBA/NFL/EPL/NRL/AFL samples.

2. **Operator control surface**
   - Sport + bet-window filters persisted in local storage.
   - Overview tiles show tracked-event count, sports coverage breadth, window-qualified events, next start, and book-poll health (per-feed "time since" readouts).

3. **Edge intelligence**
   - New Edge Board surfaces top spread/total/moneyline overlays (positive deltas vs. consensus) scoped by the active filters.
   - Entries deep-link into the event drawer for actioning.

4. **Market deep dive drawer**
   - Click any Market Move card to open a right-hand drawer with consensus summary, per-book line table (spread/total/moneyline + edges), and aggregated props (market/runner/price) grouped by book.
   - Drawer state survives auto-refresh and filter changes; it closes automatically if the event drops out of scope.

5. **UI polish + responsiveness**
   - Cards now respond to hover/active states, empty states share a unified style, and the layout remains usable down to tablet widths.

## Known Gaps Before MVP1

- No auth/role enforcement (single-user local environment only).
- Pollers still reference static sample feeds until real sportsbook endpoints are configured.
- Edge Board currently highlights only positive deltas (overlays); fade/underlay tracking is deferred.
- Moneyline edges track the home runner only; full H/D/A granularity to follow.
- No alerting/webhooks yet – operators must poll the UI.

## Next Push Candidates (toward MVP0.6+)

1. **Feed realism** – wire real DraftKings/FanDuel/TAB endpoints + rate-limit handling.
2. **Model overlays** – import model % to contextualize raw consensus deltas.
3. **Alert rules** – allow threshold subscriptions (e.g., notify when spread edge > 1.0).
4. **Edge board filters** – add toggles for overlay vs. fade, props-only view, and combat-sport specific stats.
5. **Data export** – JSON/CSV download of the current filtered set for scripting.
