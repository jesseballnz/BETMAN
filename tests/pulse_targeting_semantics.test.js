#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  prunePulseTargetingAgainstRaces,
  buildEffectivePulseScope,
  isPulseRacePast,
} = require('../scripts/pulse_targeting_semantics');

const nowSec = Math.floor(Date.now() / 1000);
const races = [
  { country: 'NZ', meeting: 'Ellerslie', race_number: 1, advertised_start: nowSec - 3600, race_status: 'Open' },
  { country: 'NZ', meeting: 'Ellerslie', race_number: 2, advertised_start: nowSec + 1800, race_status: 'Open' },
  { country: 'NZ', meeting: 'Ellerslie', race_number: 3, advertised_start: nowSec + 86400, race_status: 'Open' },
  { country: 'AUS', meeting: 'Randwick', race_number: 4, advertised_start: nowSec + 5400, race_status: 'Open' },
];

assert.strictEqual(isPulseRacePast(races[0]), true, 'already-jumped race should be past even if not yet closed');
assert.strictEqual(isPulseRacePast(races[2]), false, 'tomorrow race should remain targetable');

const pruned = prunePulseTargetingAgainstRaces({
  mode: 'mixed',
  countries: ['NZ'],
  meetings: ['Ellerslie'],
  races: ['Ellerslie::1', 'Ellerslie::2', 'Ellerslie::3', 'Randwick::4', 'Unknown::9'],
}, races);

assert.deepStrictEqual(
  pruned.races,
  ['Ellerslie::2', 'Ellerslie::3', 'Randwick::4', 'Unknown::9'],
  'past explicit races should be pruned, future/tomorrow/unknown should remain',
);

const effective = buildEffectivePulseScope(pruned, races);
assert(effective.effectiveRaceSet.has('Ellerslie::2'), 'meeting targeting should include future race inside meeting');
assert(effective.effectiveRaceSet.has('Ellerslie::3'), 'meeting targeting should include tomorrow race inside meeting');
assert(!effective.effectiveRaceSet.has('Ellerslie::1'), 'meeting targeting should not include past race inside meeting');
assert(effective.effectiveRaceSet.has('Randwick::4'), 'explicit out-of-meeting race should remain');
assert(effective.effectiveRaceSet.has('Unknown::9'), 'unknown explicit race should be preserved, not rejected');
assert.deepStrictEqual(effective.extraRaces, ['Randwick::4', 'Unknown::9'], 'overlapping explicit races should not be double-counted as extras');

console.log('pulse targeting semantics test passed');
