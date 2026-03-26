# Pedigree Advantage Launch Roadmap

## Built now
- External pedigree data file: `data/pedigree/bloodlines.v1.json`
- Race archetype classifier in `scripts/pedigree_advantage.js`
- Jurisdiction-aware pedigree priors
- Female-family scaffold
- Cross-pattern scaffold
- Tests for:
  - AUS Golden Slipper / 2YO G1 sprint archetype
  - multiple-tag thresholding
  - pass/no-tag behavior for weak fields
  - NZ wet staying archetype preference

## Next build blocks
1. Expand bloodline coverage materially
2. Add broodmare-sire / female-family result learning
3. Persist pedigree signals into audit logs
4. Weekly pedigree calibration report
5. UI columns for pedigree fit / confidence / relative edge

## Hard launch rules
- No Pedigree Advantage tag is required in any race
- Tag only on clear field-relative edge
- Multiple tags allowed only at genuinely elite threshold
- Unknown bloodlines do not get free credit
