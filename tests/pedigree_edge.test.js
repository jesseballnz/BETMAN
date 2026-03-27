#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const {
  pedigreeAdjFactor,
  trackConditionConfirmation,
  computeRacePedigreeAdvantageMap,
  loadBloodlineLibrary,
  inferRaceArchetype
} = require(path.join(ROOT, 'scripts', 'pedigree_advantage.js'));

// --- Bloodline library expansion tests ---

const library = loadBloodlineLibrary();

assert(library.bloodlines.proisir, 'library should include Proisir');
assert(library.bloodlines['per incanto'], 'library should include Per Incanto');
assert(library.bloodlines.tivaci, 'library should include Tivaci');
assert(library.bloodlines.almanzor, 'library should include Almanzor');
assert(library.bloodlines.territories, 'library should include Territories');
assert(library.bloodlines['turn me loose'], 'library should include Turn Me Loose');
assert(library.bloodlines.vadamos, 'library should include Vadamos');
assert(library.bloodlines.iffraaj, 'library should include Iffraaj');
assert(library.bloodlines['charm spirit'], 'library should include Charm Spirit');
assert(library.bloodlines.lonhro, 'library should include Lonhro');
assert(library.bloodlines['more than ready'], 'library should include More Than Ready');
assert(library.bloodlines['not a single doubt'], 'library should include Not A Single Doubt');
assert(library.bloodlines['exceed and excel'], 'library should include Exceed And Excel');
assert(library.bloodlines.hellbent, 'library should include Hellbent');
assert(library.bloodlines.capitalist, 'library should include Capitalist');
assert(library.bloodlines['super seth'], 'library should include Super Seth');
assert(library.bloodlines.tavistock, 'library should include Tavistock');
assert(library.bloodlines.jakkalberry, 'library should include Jakkalberry');
assert(library.bloodlines['rip van winkle'], 'library should include Rip Van Winkle');

// NZ sires should have NZ-focused priors
assert(library.bloodlines.proisir.priors['NZ:WET_SPRINT'] > 1, 'Proisir should have elevated NZ:WET_SPRINT prior');
assert(library.bloodlines.tavistock.priors['NZ:WET_STAYING'] > 1, 'Tavistock should have elevated NZ:WET_STAYING prior');

// New crosses
assert(library.crosses['proisir|savabeel'], 'cross library should include Proisir x Savabeel');
assert(library.crosses['capitalist|snitzel'], 'cross library should include Capitalist x Snitzel');
assert(library.crosses['almanzor|savabeel'], 'cross library should include Almanzor x Savabeel');
assert(library.crosses['tivaci|savabeel'], 'cross library should include Tivaci x Savabeel');

console.log('✓ bloodline library expansion verified');

// --- trackConditionConfirmation tests ---

// Should return 1 (neutral) when no stats
assert.strictEqual(trackConditionConfirmation({}, { archetype: 'NZ:WET_STAYING' }), 1, 'no stats should return neutral');

// Should return 1 when null signal
assert.strictEqual(trackConditionConfirmation({ stats: {} }, null), 1, 'null signal should return neutral');

// Should return 1 when less than 3 starts
const fewStartsRunner = { stats: { heavy: { number_of_starts: 2, number_of_wins: 2, number_of_placings: 2 } } };
assert.strictEqual(trackConditionConfirmation(fewStartsRunner, { archetype: 'NZ:WET_STAYING' }), 1, 'fewer than 3 starts should return neutral');

// Should boost when strong wet track record on wet archetype
const strongWetRunner = { stats: { heavy: { number_of_starts: 5, number_of_wins: 2, number_of_placings: 3 } } };
assert.strictEqual(trackConditionConfirmation(strongWetRunner, { archetype: 'NZ:WET_STAYING' }), 1.15, 'strong wet stats should boost');

// Should discount when poor wet track record on wet archetype
const poorWetRunner = { stats: { heavy: { number_of_starts: 8, number_of_wins: 0, number_of_placings: 0 } } };
assert.strictEqual(trackConditionConfirmation(poorWetRunner, { archetype: 'NZ:WET_STAYING' }), 0.7, 'poor wet stats should discount');

// Should check good stats on non-wet archetype
const strongGoodRunner = { stats: { good: { number_of_starts: 6, number_of_wins: 2, number_of_placings: 4 } } };
assert.strictEqual(trackConditionConfirmation(strongGoodRunner, { archetype: 'AUS:OPEN_SPRINT' }), 1.15, 'strong good stats on sprint archetype should boost');

// Should check soft stats on wet archetype when no heavy
const softRunner = { stats: { soft: { number_of_starts: 4, number_of_wins: 1, number_of_placings: 3 } } };
assert.strictEqual(trackConditionConfirmation(softRunner, { archetype: 'NZ:WET_MIDDLE_DISTANCE' }), 1.15, 'strong soft stats on wet archetype should boost');

console.log('✓ trackConditionConfirmation tests passed');

// --- pedigreeAdjFactor tests ---

// Should return 0 when no pedigreeMap
assert.strictEqual(pedigreeAdjFactor({ runner_name: 'Test' }, null), 0, 'null map should return 0');

// Should return 0 when runner not in map
const emptyMap = new Map();
assert.strictEqual(pedigreeAdjFactor({ runner_name: 'Ghost Runner' }, emptyMap), 0, 'missing runner should return 0');

// Should return 0 when relative edge <= 0
const negEdgeMap = new Map([['test runner', { score: 10, relativeEdge: -2, confidence: 0.8, archetype: 'AUS:OPEN_SPRINT' }]]);
assert.strictEqual(pedigreeAdjFactor({ runner_name: 'Test Runner' }, negEdgeMap), 0, 'negative relative edge should return 0');

// Should return 0 when confidence < 0.50
const lowConfMap = new Map([['test runner', { score: 30, relativeEdge: 8, confidence: 0.45, archetype: 'AUS:OPEN_SPRINT' }]]);
assert.strictEqual(pedigreeAdjFactor({ runner_name: 'Test Runner' }, lowConfMap), 0, 'low confidence should return 0');

// Should return positive adjustment for strong pedigree
const strongMap = new Map([['blue blood', { score: 40, relativeEdge: 10, confidence: 0.85, archetype: 'AUS:2YO_SPRINT_G1' }]]);
const adj = pedigreeAdjFactor({ runner_name: 'Blue Blood' }, strongMap);
assert(adj > 0, 'strong pedigree should give positive adjustment');
assert(adj <= 0.02, 'adjustment should be capped at 0.02');

// Should cap at 0.02
const extremeMap = new Map([['extreme', { score: 100, relativeEdge: 50, confidence: 0.99, archetype: 'AUS:OPEN_SPRINT' }]]);
const extremeAdj = pedigreeAdjFactor({ runner_name: 'Extreme' }, extremeMap);
assert(extremeAdj > 0.015 && extremeAdj <= 0.02, 'extreme pedigree should approach but not exceed 0.02 cap');

// Should scale with relative edge and confidence
const moderateMap = new Map([['moderate', { score: 25, relativeEdge: 5, confidence: 0.65, archetype: 'AUS:OPEN_SPRINT' }]]);
const moderateAdj = pedigreeAdjFactor({ runner_name: 'Moderate' }, moderateMap);
assert(moderateAdj > 0 && moderateAdj < adj, 'moderate pedigree should give smaller adjustment than strong');

// Should incorporate track confirmation boost
const confirmedMap = new Map([['confirmed', { score: 30, relativeEdge: 8, confidence: 0.80, archetype: 'NZ:WET_STAYING' }]]);
const confirmedAdj = pedigreeAdjFactor({ runner_name: 'Confirmed', stats: { heavy: { number_of_starts: 5, number_of_wins: 2, number_of_placings: 3 } } }, confirmedMap);
const unconfirmedAdj = pedigreeAdjFactor({ runner_name: 'Confirmed' }, confirmedMap);
assert(confirmedAdj > unconfirmedAdj, 'track-confirmed runner should get higher adjustment');

// Should incorporate track confirmation discount
const discountMap = new Map([['poor track', { score: 30, relativeEdge: 8, confidence: 0.80, archetype: 'NZ:WET_STAYING' }]]);
const discountAdj = pedigreeAdjFactor({ runner_name: 'Poor Track', stats: { heavy: { number_of_starts: 8, number_of_wins: 0, number_of_placings: 0 } } }, discountMap);
assert(discountAdj < unconfirmedAdj, 'poor-track runner should get lower adjustment');

console.log('✓ pedigreeAdjFactor tests passed');

// --- Integration test: pedigree adjustment flows into advantage map ---

const goldenSlipper = {
  country: 'AUS',
  description: 'Golden Slipper Group 1 2YO',
  distance: 1200,
  track_condition: 'Good4'
};

const runners = [
  { name: 'Blue Blood', sire: 'Snitzel', dam: 'Fastnet Lass', dam_sire: 'Fastnet Rock' },
  { name: 'Speed Line', sire: 'I Am Invincible', dam: 'Sharp Madam', dam_sire: 'I Am Invincible' },
  { name: 'Unknown Colt', sire: 'Unknown Sire', dam: 'Unknown Dam', dam_sire: 'Unknown Damsire' }
];

const map = computeRacePedigreeAdvantageMap(goldenSlipper, runners);

// The qualified runner with high relative edge should get positive pedigreeAdjFactor
const blueBloodAdj = pedigreeAdjFactor({ runner_name: 'Blue Blood' }, map);
const unknownAdj = pedigreeAdjFactor({ runner_name: 'Unknown Colt' }, map);
assert(blueBloodAdj > unknownAdj, 'known pedigree runner should get higher adjustment than unknown');

// NZ wet race should favor NZ sires
const nzWet = {
  country: 'NZ',
  description: 'Open Handicap',
  distance: 2100,
  track_condition: 'Heavy8'
};
const nzRunners = [
  { name: 'Wet Blue', sire: 'Savabeel', dam: 'Market Girl', dam_sire: 'Tavistock' },
  { name: 'Dry Dash', sire: 'I Am Invincible', dam: 'Sharp Madam', dam_sire: 'I Am Invincible' }
];
const nzMap = computeRacePedigreeAdvantageMap(nzWet, nzRunners);
const wetAdj = pedigreeAdjFactor({ runner_name: 'Wet Blue' }, nzMap);
const dryAdj = pedigreeAdjFactor({ runner_name: 'Dry Dash' }, nzMap);
assert(wetAdj > dryAdj, 'NZ staying sire should get higher adjustment in NZ wet staying race');

// NZ sprint with NZ sires
const nzSprint = {
  country: 'NZ',
  description: 'Open Sprint',
  distance: 1200,
  track_condition: 'Soft5'
};
const nzSprintRunners = [
  { name: 'Local Flyer', sire: 'Proisir', dam: 'Unknown Dam', dam_sire: 'Savabeel' },
  { name: 'Dry Runner', sire: 'Written Tycoon', dam: 'Unknown Dam', dam_sire: 'Zoustar' }
];
const nzSprintMap = computeRacePedigreeAdvantageMap(nzSprint, nzSprintRunners);
const localAdj = pedigreeAdjFactor({ runner_name: 'Local Flyer' }, nzSprintMap);
assert(localAdj >= 0, 'NZ wet sprint sire in wet sprint should get non-negative adjustment');

console.log('✓ pedigree edge integration tests passed');
console.log('pedigree_edge tests passed');
