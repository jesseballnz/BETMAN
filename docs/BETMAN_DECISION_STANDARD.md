# BETMAN Decision Standard (MVP1.1)

Purpose: enforce clear, consistent, auditable decision quality across API + UI.

## 1) Required decision structure
Every recommendation should map to:
1. Verdict
2. Evidence
3. Risk
4. Action or Pass

## 2) Probability discipline
When odds are available, always compute:
- Implied % = 100 / decimal odds
- Edge (pts) = Model % - Implied %

If model % is unavailable, explicitly state `unavailable`.

## 3) Scope discipline
- Respect selected meeting/race context.
- No cross-meeting blending unless explicitly labeled fallback.

## 4) Invalidation discipline
Each actionable output should include invalidation points.
Examples:
- market drift beyond threshold
- map/tempo shape invalidates expected run style
- scratchings altering pace setup

## 5) Risk language
Use plain risk labels:
- low
- medium
- high

## 6) API enforcement
`/api/status` should include a decision audit block:
- totals
- compliance score
- missing fields counts

`/api/ask-selection` should ensure answer includes:
- Verdict
- Market edge
- Risk
- Invalidation points

For Same-Race/H2H requests, include explicit pair joint likelihood.

## 7) Render enforcement
UI render paths should rely on standardized fields from API where available:
- modelProb
- impliedProb
- edgePts
- riskLabel
- invalidation

When absent, render `unavailable` (never hallucinate values).
