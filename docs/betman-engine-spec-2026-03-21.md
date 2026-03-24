# BETMAN Revised Engine Spec — 2026-03-21

## Objective
Improve winner selection quality by separating:
1. horse ability modelling
2. descriptive form/track tags
3. bet-structure tags
4. calibration and confidence blending

---

## 1) Core win model
For each runner `i`:

```text
RawRating_i =
  0.26 * Ability_i +
  0.18 * Map_i +
  0.15 * Sectionals_i +
  0.12 * Form_i +
  0.10 * TrackDistance_i +
  0.07 * JockeyTrainer_i +
  0.05 * Weight_i +
  0.04 * Barrier_i +
  0.03 * Prep_i
```

Convert ratings to raw win probabilities:

```text
RawProb_i = exp(lambda * RawRating_i) / sum_j exp(lambda * RawRating_j)
```

Default `lambda`: `0.060` to `0.085`, tuned by backtest.

---

## 2) Form scoring
Use a recency-weighted score instead of a boolean “good form” gate.

### Finish points
- 1st = +12
- 2nd = +9
- 3rd = +7
- 4th = +4
- 5th = +2
- 6th–7th = 0
- 8th–10th = -4
- 11th+ = -7

### Weights
- Last start = 0.45
- 2nd-last = 0.25
- 3rd-last = 0.18
- 4th-last = 0.12

### Formula
```text
FormScore = sum(weight_k * finishPoints_k)
```

### Modifiers
- Last start top 3: `+4`
- Last start win: `+3`
- Last start 8th+: `-6`
- Two consecutive poor runs (6th+ then 6th+): `-4`
- Improving pattern across last 3 runs: `+2`

---

## 3) Form tag rules
### HOT FORM
A horse can only be HOT if:
- last start was top 3
- and one of:
  - 2 wins in last 4
  - 2 podiums in last 3
  - 3 top-4 finishes in last 5
- and `FormScore >= 12`

### SOLID FORM
- Not HOT
- and either:
  - last start top 5 with enough recent support
  - or `FormScore >= 5`

### MIXED FORM
- Patchy profile, contradictions, or `FormScore >= -2`

### COLD FORM
- Repeated poor runs, weak score, poor latest run

### Hard downgrade
If last start was worse than 3rd:
- runner **cannot** be HOT
- max tag becomes SOLID

---

## 4) Track state preference model
Track states are grouped into:
- GOOD
- SOFT
- HEAVY
- FIRM

### Track suitability score
```text
TrackScore = 0.40 * SurfaceRecord +
             0.25 * RecentSameGround +
             0.15 * SectionalFit +
             0.10 * BreedingFit +
             0.10 * StyleFit
```

### Sample shrinkage
```text
SurfaceRecordAdj = (n / (n + 3)) * SurfaceRecordRaw
```

### Labels
- `>= +8`: LOVES THIS GROUND
- `+3 to +7.9`: SUITED
- `-2.9 to +2.9`: NEUTRAL
- `-3 to -7.9`: QUERY
- `<= -8`: DISLIKES THIS GROUND

### Reliability
```text
TrackReliability = clamp(0.2, 1.0, starts_on_bucket / 6)
```

### Simulation injection
```text
AdjMean_i = BaseMean_i + TrackAdj_i
AdjSigma_i = BaseSigma_i * TrackVarianceFactor_i
```

Where `TrackAdj_i` is derived from TrackScore and Reliability.

---

## 5) Confidence blending
Model probabilities should not run unanchored.

### Confidence score
Start at `0.35`, then add:
- career/track stats present: `+0.15`
- sectionals present: `+0.10`
- speed map present: `+0.10`
- form sample length >= 4: `+0.10`
- track reliability contribution: up to `+0.15`

Clamp to `0.25–0.80`.

### Blend
```text
FinalProb_i = Confidence_i * RawProb_i + (1 - Confidence_i) * FairMarketProb_i + TrackAdj_i
```

### Probability cap
Clamp final win probabilities into a safer band unless true dominance exists:
- floor: `2%`
- cap: `42%`

---

## 6) Calibration
Historical calibration multipliers should be shrunk by sample confidence.

### Sample confidence
```text
BinConfidence = min(1, bin_samples / 250)
```

### Safe multiplier
```text
SafeMultiplier = 1 + ((clamp(0.75, 1.25, RawMultiplier) - 1) * BinConfidence)
```

This prevents tiny bins from causing wild over-corrections.

---

## 7) Odds vs Model Probabilities table
Each row should expose:
- market odds
- market implied %
- fair market % (margin removed where available)
- model raw %
- calibrated/blended %
- edge %
- confidence %
- track tag / form tag

This table is diagnostic, not theatre.

---

## 8) Bet tags
### Recommended Bet
Highest bet-quality score after EV, confidence and contradiction filters.

```text
BetScore = 0.50 * Edge +
           0.20 * Confidence +
           0.15 * MapAdvantage +
           0.10 * FormReliability +
           0.05 * MarketSupport
```

### Odds Runner
Largest positive overlay with acceptable confidence.

### EW
Use where place profile > win profile and place edge is stronger.

### LONG
Long odds horse with real upside — not just a number.

#### LONG hard requirements
- odds >= 8.0
- form tag HOT or SOLID
- track tag not DISLIKES THIS GROUND
- no hard-fail latest run profile
- model win % >= 7.5%

#### LONG hard exclusions
- last start 9th+ with negative form score
- cold form
- bad map with no offsetting positives
- negative track profile

---

## 9) Decision tree
### Step 1
Build runner factors:
- Ability
- Map
- Sectionals
- Form
- Track/Distance
- Jockey/Trainer
- Weight
- Barrier
- Prep

### Step 2
Convert to `RawProb`.

### Step 3
Apply calibration + confidence blend + track adjustment.

### Step 4
Assign descriptive tags:
- HOT / SOLID / MIXED / COLD
- track preference label

### Step 5
Assign bet-structure tags:
- Recommended Bet
- Odds Runner
- EW
- LONG

### Step 6
Filter bad bets:
- negative EV
- low confidence
- contradiction stack too high
- cold-form recommended runner

---

## 10) Weekly self-tuning framework
Track these metrics weekly:

### A. Form tag accuracy
For HOT / SOLID / MIXED / COLD:
- win rate
- place rate
- ROI
- average overlay realised

### B. Track tag accuracy
For LOVES / SUITED / NEUTRAL / QUERY / DISLIKES:
- win rate by tag
- ROI by tag
- actual-vs-predicted win rate

### C. Overlay accuracy
Bucket by edge:
- `0–2 pts`
- `2–5 pts`
- `5–10 pts`
- `10+ pts`

Measure:
- actual win rate
- ROI
- false-positive rate

### D. Calibration drift
For probability bins:
- avg predicted
- actual win rate
- multiplier drift
- sample size

### E. Auto-reweighting
Only reweight weekly if:
- minimum sample threshold met
- challenger beats champion on ROI and Brier/log loss
- no severe degradation in win rate / hit rate stability

Suggested rule:
```text
new_weight = 0.8 * old_weight + 0.2 * observed_weight
```

Do not fully jump weights on a single week.

---

## 11) Governance
No automatic promotion unless:
- sample threshold met
- challenger outperforms on at least 2 of 3:
  - ROI
  - calibration quality
  - hit rate
- no major drawdown increase

Human review remains final gate.
