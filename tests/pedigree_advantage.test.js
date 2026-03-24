#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const {
  inferRaceArchetype,
  inferRacePedigreeDemand,
  runnerPedigreeSignal,
  computeRacePedigreeAdvantageMap,
  loadBloodlineLibrary
} = require(path.join(ROOT, 'scripts', 'pedigree_advantage.js'));

const library = loadBloodlineLibrary();
assert(library.bloodlines.snitzel, 'bloodline library should load Snitzel');
assert(library.crosses['snitzel|fastnet rock'], 'cross library should load Snitzel x Fastnet Rock');

const goldenSlipper = {
  country: 'AUS',
  description: 'Golden Slipper Group 1 2YO',
  distance: 1200,
  track_condition: 'Good4'
};
assert.strictEqual(inferRaceArchetype(goldenSlipper), 'AUS:2YO_SPRINT_G1', 'Golden Slipper should map to 2YO G1 sprint archetype');

const wetStaying = {
  country: 'NZ',
  description: 'Open Handicap',
  distance: 2100,
  track_condition: 'Heavy8'
};
assert.strictEqual(inferRaceArchetype(wetStaying), 'NZ:WET_STAYING', 'NZ heavy staying race should map to wet staying archetype');

const demand = inferRacePedigreeDemand(goldenSlipper);
assert(demand.slipper > 1, 'Golden Slipper should create elevated slipper demand');
assert(demand.juvenile >= 1, 'Golden Slipper should create juvenile demand');

const runners = [
  { name: 'Blue Blood', sire: 'Snitzel', dam: 'Fastnet Lass', dam_sire: 'Fastnet Rock' },
  { name: 'Speed Line', sire: 'I Am Invincible', dam: 'Sharp Madam', dam_sire: 'I Am Invincible' },
  { name: 'Tycoon Star', sire: 'Written Tycoon', dam: 'Market Girl', dam_sire: 'Zoustar' },
  { name: 'Unknown Colt', sire: 'Unknown Sire', dam: 'Unknown Dam', dam_sire: 'Unknown Damsire' }
];

const snitzelSignal = runnerPedigreeSignal(runners[0], goldenSlipper);
const invSignal = runnerPedigreeSignal(runners[1], goldenSlipper);
assert(snitzelSignal.score > invSignal.score, 'Snitzel profile should outrank I Am Invincible in this configured Slipper example');
assert(/AUS:2YO_SPRINT_G1/.test(snitzelSignal.summary), 'signal summary should expose archetype');

const map = computeRacePedigreeAdvantageMap(goldenSlipper, runners);
const blueBlood = map.get('blue blood');
const speedLine = map.get('speed line');
const tycoonStar = map.get('tycoon star');
const unknown = map.get('unknown colt');

assert(blueBlood && blueBlood.qualifies, 'top pedigree runner should qualify');
assert(speedLine && !speedLine.qualifies, 'second-best runner should not qualify unless within the high threshold');
assert(tycoonStar && !tycoonStar.qualifies, 'non-elite relative edge should not force multiple pedigree tags');
assert(unknown && !unknown.qualifies, 'unknown bloodline should not qualify');

const tightField = [
  { name: 'A', sire: 'Snitzel', dam: 'Fastnet Lass', dam_sire: 'Fastnet Rock' },
  { name: 'B', sire: 'Snitzel', dam: 'Fastnet Lass', dam_sire: 'Fastnet Rock' },
  { name: 'C', sire: 'I Am Invincible', dam: 'Sharp Madam', dam_sire: 'Fastnet Rock' }
];
const tightMap = computeRacePedigreeAdvantageMap(goldenSlipper, tightField);
assert(tightMap.get('a').qualifies, 'runner A should qualify');
assert(tightMap.get('b').qualifies, 'runner B can also qualify when the score remains inside the high band');

const nzWetRunners = [
  { name: 'Wet Blue', sire: 'Savabeel', dam: 'Market Girl', dam_sire: 'Ocean Park' },
  { name: 'Dry Dash', sire: 'I Am Invincible', dam: 'Sharp Madam', dam_sire: 'I Am Invincible' }
];
const wetMap = computeRacePedigreeAdvantageMap(wetStaying, nzWetRunners);
assert(wetMap.get('wet blue').score > wetMap.get('dry dash').score, 'wet-staying archetype should favor NZ staying/wet bloodlines');

console.log('pedigree_advantage tests passed');
