const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

assert(appJs.includes('function raceIdentityMatches(row, target = {})'), 'missing race identity matcher');
assert(appJs.includes('async function alignSelectionUniverse(target = {})'), 'missing selection-universe alignment helper');
assert(appJs.includes('await alignSelectionUniverse({\n    meeting: meetingMeta.meeting,'), 'meeting search should align country+meeting universe before rendering');
assert(appJs.includes('race = (all || []).find(r => raceIdentityMatches(r, { key, meeting: fallbackMeeting, raceNumber: fallbackRace }));'), 'selectRace should recover races from the unfiltered universe');
assert(appJs.includes('const resolvedRace = (racesCache || []).find(r => raceIdentityMatches(r, race))'), 'selectRace should rebind onto the active scoped cache when possible');
assert(appJs.includes('if (selectedRace.country && normalizeUiCountry(selectedRace.country, \'\') && normalizeUiCountry(selectedRace.country, \'\') !== \'ALL\')'), 'selectRace should keep selectedCountry coherent with the selected race');
assert(appJs.includes('let race = racesCache.find(r => raceIdentityMatches(r, target));'), 'button race lookup should use unified identity matching');
assert(appJs.includes('const finder = collection => (collection || []).find(r => raceIdentityMatches(r, target)) || null;'), 'lookupRace should use unified identity matching');

console.log('meeting_universe_coherence test passed');
