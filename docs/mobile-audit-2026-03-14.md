# Mobile Audit — 14 Mar 2026

## Quick findings

1. **Filter toolbar overflowed on sub-400px screens.** `display:flex` without wrapping forced the Day/Country/Meeting controls into a single line that clipped off-screen. Added `flex-wrap: wrap` to `.filters` so controls stack cleanly on mobile.
2. **Odds vs Model table was unreadable on phones.** Ten columns stretched beyond the viewport with no scroll affordance. Introduced an `.analysis-table-scroll` wrapper with horizontal scroll + a 720px intrinsic width (600px on <640px) so mobile users can pan without the card shrinking columns to illegible widths.
3. **Section headers squeezed Poll button.** The new Poll Odds button and heading contested space on small screens. Updated `.analysis-block-head` to stack vertically under 640px, preventing text truncation and misaligned buttons.

## Remaining mobile gaps to schedule

- **Race cards grid:** At ~360px width the race-card scroller still requires precise horizontal dragging. Consider a dedicated `@media` rule to widen the tap targets and reduce per-card padding.
- **AI Chat dock:** Even with the existing 640px rule, the panel can obscure race content when the keyboard is open. Future iteration: convert to a bottom sheet with dismiss handle for <600px viewports.
- **Value board rows:** The table-style `.row` layout becomes a long stack. We should explicitly inject labels (e.g., "Win Edge:") for each metric when in single-column mode to avoid ambiguity.

These items can move into the next polish sprint; no blocking regressions observed after today’s fixes.
