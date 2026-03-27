# Bloodline Library Notes

This library backs clickable Sire / Dam / Dam Sire links inside BETMAN runner profiles.

## Purpose
Make pedigree inspectable in the UI instead of burying it in static text.
Pedigree signals now contribute to the probability model and edge calculation via `pedigreeAdjFactor`.

## Current behavior
Clicking a bloodline opens a profile popup with:
- summary commentary
- style note
- trait profile
- strengths
- cautions

## Pedigree edge integration
- Runners with strong pedigree-to-race fit receive a probability adjustment (up to ~2%)
- Track condition stats cross-validate bloodline wet/good traits
- `pedigreeEdgeContribution` field on bet plans shows the pedigree contribution to edge
- Overlay/underlay analysis text includes pedigree contribution when present

## Coverage
Current bloodline coverage includes:

### Australia
- Snitzel, Fastnet Rock, I Am Invincible, Written Tycoon, Zoustar
- Pierro, Merchant Navy, Capitalist, Hellbent, Super Seth
- Exceed And Excel, Not A Single Doubt, More Than Ready, Lonhro

### New Zealand
- Savabeel, Ocean Park, So You Think, Tavistock, Jakkalberry
- Proisir, Per Incanto, Tivaci, Almanzor, Territories
- Turn Me Loose, Vadamos, Iffraaj, Charm Spirit, Rip Van Winkle

### International
- Deep Impact, Frankel

## Next expansion
- move commentary into external structured data
- add dam-family-specific notes
- add broodmare-sire commentary
- add result-learned commentary signals
- auto-ingest new sire data from Breednet tables
