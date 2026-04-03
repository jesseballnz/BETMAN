const assert = require('assert');
const {
  isPulseRacePast,
  isPulseRaceTargetable,
  prunePulseTargetingAgainstRaces,
} = require('../scripts/pulse_targeting_semantics');

const futureStart = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const jumpedRace = {
  country: 'NZ',
  meeting: 'Ellerslie',
  race_number: 5,
  advertised_start: futureStart,
  race_status: 'Jumped',
};

assert.strictEqual(isPulseRacePast(jumpedRace), true, 'jumped status should be treated as past even if advertised start is still future');
assert.strictEqual(isPulseRaceTargetable(jumpedRace), false, 'jumped status should never remain targetable');

const pruned = prunePulseTargetingAgainstRaces({
  mode: 'races',
  races: ['Ellerslie::5'],
}, [jumpedRace]);

assert.deepStrictEqual(pruned.races, [], 'jumped explicit race should be pruned from pulse targeting');

console.log('pulse_started_status_targeting.test.js: ok');
