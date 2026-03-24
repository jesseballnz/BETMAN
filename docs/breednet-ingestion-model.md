# Breednet Ingestion Model

## Purpose
Turn Breednet sire-table evidence into structured BETMAN pedigree data for same-day use.

## Current source snapshot
- `data/pedigree/breednet/sire_tables_2026-03-21.txt`

## Ingestion script
- `scripts/breednet_ingest.js`

## Data flow
1. Capture source snapshot text
2. Parse table sections
3. Map section → trait weights / race priors
4. Merge into `data/pedigree/bloodlines.v1.json`
5. Emit ingest report to `memory/breednet-ingest-report.json`

## Current section mappings
- General Sires by Earnings → elite / sprint / juvenile support
- First/Second/Third Season → juvenile / precocity development
- Two Year Old Sires → juvenile / precocity / slipper support
- 1200m and shorter → sprint support
- 1200m to 1600m → sprint-mile support
- 1600m to 2000m → middle-distance / stamina support
- 2000m plus → staying support
- Broodmare Sires → dam-side relevance prior

## Bloodline schema
```json
{
  "bloodlines": {
    "snitzel": {
      "sireLine": "redoute's choice",
      "jurisdictions": ["AUS", "NZ"],
      "traits": {
        "juvenile": 16,
        "sprint": 14,
        "wet": 5,
        "slipper": 22,
        "elite": 8,
        "precocity": 15,
        "staying": 0
      },
      "priors": {
        "AUS:2YO_SPRINT_G1": 1.18
      },
      "commentary": {
        "breednet": "text",
        "sources": ["breednet:sire_tables_2026-03-21"]
      }
    }
  }
}
```

## Launch note
This is evidence-backed expansion, not final pedigree completeness. Dam-side, broodmare-sire commentary, and stallion-page ingestion should continue after launch-day readiness is secured.
