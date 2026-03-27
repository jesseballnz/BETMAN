#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  inferNextRaceAtVenue,
  formatStatsCompact,
  buildAiContextSummary,
  buildSelectionFactAnswer
} = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ─── inferNextRaceAtVenue ───────────────────────────────────────────────────

const races = [
  { meeting: 'Wingatui', race_number: 3, race_status: 'Final', description: 'R3 Done' },
  { meeting: 'Wingatui', race_number: 4, race_status: 'Final', description: 'R4 Done' },
  { meeting: 'Wingatui', race_number: 5, race_status: 'Open', description: 'R5 Open', distance: 1400 },
  { meeting: 'Wingatui', race_number: 6, race_status: 'Open', description: 'R6 Open', distance: 1600 },
  { meeting: 'Wingatui', race_number: 7, race_status: 'Open', description: 'R7 Open', distance: 2000 },
  { meeting: 'Ellerslie', race_number: 2, race_status: 'Open', description: 'ELL R2' }
];

// 1) "next race" at Wingatui should return R5 (first non-final)
const next1 = inferNextRaceAtVenue('Give me the next Wingatui race', races, 'Wingatui');
assert.ok(next1, 'should find next race');
assert.strictEqual(next1.race_number, 5, 'next Wingatui race should be R5');
assert.strictEqual(next1.description, 'R5 Open');

// 2) "next race" for Ellerslie should return R2
const next2 = inferNextRaceAtVenue('Tell me about the next Ellerslie race', races, 'Ellerslie');
assert.ok(next2, 'should find next Ellerslie race');
assert.strictEqual(next2.race_number, 2);

// 3) No "next" in question → null
const next3 = inferNextRaceAtVenue('Give me Wingatui tips', races, 'Wingatui');
assert.strictEqual(next3, null, 'no "next" keyword → null');

// 4) No venue → null
const next4 = inferNextRaceAtVenue('Give me the next race', races, null);
assert.strictEqual(next4, null);

// 5) All races at venue are final → null
const allFinal = [
  { meeting: 'Wingatui', race_number: 1, race_status: 'Final' },
  { meeting: 'Wingatui', race_number: 2, race_status: 'Resulted' }
];
const next5 = inferNextRaceAtVenue('next Wingatui race', allFinal, 'Wingatui');
assert.strictEqual(next5, null, 'all final → null');

// 6) Various finished statuses excluded
const mixedStatus = [
  { meeting: 'Wingatui', race_number: 1, race_status: 'Closed' },
  { meeting: 'Wingatui', race_number: 2, race_status: 'Abandoned' },
  { meeting: 'Wingatui', race_number: 3, race_status: 'Open' }
];
const next6 = inferNextRaceAtVenue('next Wingatui race', mixedStatus, 'Wingatui');
assert.ok(next6);
assert.strictEqual(next6.race_number, 3, 'closed/abandoned excluded, R3 is next');

console.log('inferNextRaceAtVenue tests passed');

// ─── formatStatsCompact ────────────────────────────────────────────────────

// 7) Formats track/distance/condition stats correctly
const stats1 = formatStatsCompact({
  track: { number_of_starts: 5, number_of_wins: 2, number_of_seconds: 1, number_of_thirds: 0 },
  distance: { number_of_starts: 8, number_of_wins: 3, number_of_seconds: 2, number_of_thirds: 1 },
  good: { number_of_starts: 10, number_of_wins: 4, number_of_seconds: 1, number_of_thirds: 2 }
});
assert.ok(stats1.includes('track 5:2-1-0'), `should format track stats, got: ${stats1}`);
assert.ok(stats1.includes('dist 8:3-2-1'), `should format distance stats, got: ${stats1}`);
assert.ok(stats1.includes('good 10:4-1-2'), `should format good stats, got: ${stats1}`);

// 8) Null/undefined stats → null
assert.strictEqual(formatStatsCompact(null), null);
assert.strictEqual(formatStatsCompact(undefined), null);
assert.strictEqual(formatStatsCompact({}), null);

// 9) Stats with 0 starts are excluded
const stats2 = formatStatsCompact({
  track: { number_of_starts: 0, number_of_wins: 0, number_of_seconds: 0, number_of_thirds: 0 },
  distance: { number_of_starts: 3, number_of_wins: 1, number_of_seconds: 0, number_of_thirds: 1 }
});
assert.ok(!stats2.includes('track'), 'zero-start stats excluded');
assert.ok(stats2.includes('dist 3:1-0-1'));

// 10) First-up and second-up stats
const stats3 = formatStatsCompact({
  first_up: { number_of_starts: 4, number_of_wins: 2, number_of_seconds: 1, number_of_thirds: 0 },
  second_up: { number_of_starts: 3, number_of_wins: 1, number_of_seconds: 1, number_of_thirds: 1 }
});
assert.ok(stats3.includes('1st-up 4:2-1-0'));
assert.ok(stats3.includes('2nd-up 3:1-1-1'));

console.log('formatStatsCompact tests passed');

// ─── buildAiContextSummary enriched RACE_FIELD_DATA ─────────────────────────

// 11) RACE_FIELD_DATA includes enriched fields
const contextRaces = [
  {
    meeting: 'Wingatui',
    race_number: 5,
    description: 'Test Race',
    distance: 1400,
    track_condition: 'Good',
    rail_position: 'True',
    runners: [
      {
        runner_number: 3, name: 'Strong', barrier: 12, jockey: 'T Comignaghi',
        trainer: 'B Tapper', trainer_location: 'Dunedin', weight_total: 57.5,
        age: 5, sex: 'G', gear: 'B', last_twenty_starts: '03636',
        last_starts: '636', form_comment: 'Consistent performer',
        form_indicators: 'Form on Good;Trainer / Jockey Combo',
        apprentice_indicator: null, speedmap: 'Off Pace',
        sire: 'Savabeel', dam: 'Strong Lady', dam_sire: 'Darci Brahma',
        fixed_win: 3.60,
        stats: {
          track: { number_of_starts: 4, number_of_wins: 2, number_of_seconds: 1, number_of_thirds: 0 },
          distance: { number_of_starts: 6, number_of_wins: 1, number_of_seconds: 2, number_of_thirds: 1 }
        }
      },
      {
        runner_number: 1, name: 'Fast One', barrier: 1, jockey: 'O Bosson',
        trainer: 'S Marsh', weight_total: 56, last_twenty_starts: '11x23',
        speedmap: 'Leader', sire: 'Almanzor', dam: 'Quick Lady', dam_sire: 'Pins',
        fixed_win: 2.40
      }
    ]
  }
];

const summary = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  clientContext: { raceContext: { meeting: 'Wingatui', raceNumber: '5' } },
  races: contextRaces,
  meetingProfiles: {},
  maxLength: 20000
});

// Verify RACE_FIELD_DATA is present and has enriched fields
assert.ok(summary.includes('RACE_FIELD_DATA'), 'should include RACE_FIELD_DATA');
assert.ok(summary.includes('MANDATORY_RACE_VALUES'), 'should include MANDATORY_RACE_VALUES');

// Parse the RACE_FIELD_DATA JSON to verify structure
const fieldMatch = summary.match(/RACE_FIELD_DATA: (\[.*?\])/);
assert.ok(fieldMatch, 'should have parseable RACE_FIELD_DATA JSON');
const fieldData = JSON.parse(fieldMatch[1]);

// Verify enriched fields are present
const strongRunner = fieldData.find(r => r.runner === 'Strong');
assert.ok(strongRunner, 'Should have Strong runner in field data');
assert.strictEqual(strongRunner.runnerNumber, 3, 'runner number present');
assert.strictEqual(strongRunner.barrier, 12, 'barrier present');
assert.strictEqual(strongRunner.jockey, 'T Comignaghi', 'jockey present');
assert.strictEqual(strongRunner.trainer, 'B Tapper', 'trainer present');
assert.strictEqual(strongRunner.trainerLocation, 'Dunedin', 'trainer location present');
assert.strictEqual(strongRunner.age, 5, 'age present');
assert.strictEqual(strongRunner.sex, 'G', 'sex present');
assert.strictEqual(strongRunner.gear, 'B', 'gear present');
assert.strictEqual(strongRunner.formComment, 'Consistent performer', 'form comment present');
assert.strictEqual(strongRunner.formIndicators, 'Form on Good;Trainer / Jockey Combo', 'form indicators present');
assert.strictEqual(strongRunner.lastStarts, '636', 'last starts present');
assert.ok(strongRunner.stats, 'stats should be present');
assert.ok(strongRunner.stats.includes('track 4:2-1-0'), `stats should include track data, got: ${strongRunner.stats}`);
assert.ok(strongRunner.stats.includes('dist 6:1-2-1'), `stats should include distance data, got: ${strongRunner.stats}`);

console.log('enriched RACE_FIELD_DATA tests passed');

// ─── buildSelectionFactAnswer: next-race scoping ────────────────────────────

const TENANT_ID = 'next_race_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', TENANT_ID, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-03-27T01:00:00.000Z',
  suggestedBets: [
    { meeting: 'Wingatui', race: '5', selection: 'Fast One', type: 'Win', stake: 5.0, reason: 'p=28.0% @ 2.40' },
    { meeting: 'Wingatui', race: '5', selection: 'Strong', type: 'Win', stake: 3.5, reason: 'p=18.9% @ 3.60' },
    { meeting: 'Wingatui', race: '6', selection: 'Imperative', type: 'Win', stake: 2.0, reason: 'p=14.2% @ 4.20' }
  ]
};

const racesFixture = {
  races: [
    {
      meeting: 'Wingatui', race_number: 4, description: 'R4 Done', race_status: 'Final',
      runners: [{ runner_number: 1, name: 'OldRunner', odds: 5.0 }]
    },
    {
      meeting: 'Wingatui', race_number: 5, description: 'R5 Open', race_status: 'Open', distance: 1400,
      runners: [
        { runner_number: 1, name: 'Fast One', odds: 2.40 },
        { runner_number: 3, name: 'Strong', odds: 3.60 }
      ]
    },
    {
      meeting: 'Wingatui', race_number: 6, description: 'R6 Open', race_status: 'Open', distance: 1600,
      runners: [
        { runner_number: 2, name: 'Imperative', odds: 4.20 }
      ]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

// 12) "next race" at Wingatui should return R5 suggestions, not R6
const answer = buildSelectionFactAnswer('Give me the strongest betting angle from the next Wingatui race.', {}, TENANT_ID);
assert.ok(/Race 5/i.test(answer) || /R5/i.test(answer) || /Fast One/i.test(answer),
  `Expected R5 or Fast One in answer, got: ${answer.slice(0, 200)}`);
assert.ok(!/Imperative/i.test(answer),
  `Should NOT mention R6 runner Imperative, got: ${answer.slice(0, 200)}`);

// 13) Without "next", all Wingatui suggestions should appear
const answerAll = buildSelectionFactAnswer('Who is the top pick at Wingatui?', {}, TENANT_ID);
assert.ok(/Fast One/i.test(answerAll) || /Strong/i.test(answerAll),
  `General Wingatui question should show suggestions, got: ${answerAll.slice(0, 200)}`);

// Cleanup
try { fs.rmSync(path.join(ROOT, 'memory', 'tenants', TENANT_ID), { recursive: true }); } catch (e) {
  if (e.code !== 'ENOENT') console.warn('cleanup warning:', e.message);
}

console.log('buildSelectionFactAnswer next-race scoping tests passed');

// ─── buildSelectionFactAnswer: multi handling ───────────────────────────────

const MULTI_TENANT = 'multi_test';
const multiDir = path.join(ROOT, 'memory', 'tenants', MULTI_TENANT, 'frontend-data');
fs.mkdirSync(multiDir, { recursive: true });

const multiStatus = {
  updatedAt: '2026-03-27T01:00:00.000Z',
  suggestedBets: [
    { meeting: 'Wingatui', race: '5', selection: 'Fast One', type: 'Win', stake: 5.0, reason: 'p=28.0% @ 2.40' },
    { meeting: 'Ellerslie', race: '3', selection: 'Thunder', type: 'Win', stake: 4.0, reason: 'p=22.0% @ 3.50' },
    { meeting: 'Wingatui', race: '5', selection: 'Fast One / Strong', type: 'Top2', stake: 1.0, reason: 'Top-2 profile from adjusted win probabilities' }
  ]
};

const multiRaces = { races: [
  { meeting: 'Wingatui', race_number: 5, description: 'R5', race_status: 'Open', runners: [] },
  { meeting: 'Ellerslie', race_number: 3, description: 'R3', race_status: 'Open', runners: [] }
]};

fs.writeFileSync(path.join(multiDir, 'status.json'), JSON.stringify(multiStatus, null, 2));
fs.writeFileSync(path.join(multiDir, 'races.json'), JSON.stringify(multiRaces, null, 2));

// 14) "pick me a multi" should return multi/exotic suggestions
const multiAnswer = buildSelectionFactAnswer('pick me a multi', {}, MULTI_TENANT);
assert.ok(/Top2/i.test(multiAnswer) || /exotic/i.test(multiAnswer) || /multi/i.test(multiAnswer),
  `Multi question should mention exotics, got: ${multiAnswer.slice(0, 200)}`);
assert.ok(!/Do you want this analysed as H2H/i.test(multiAnswer),
  'Should NOT ask for H2H/SRM clarification');

// 15) When no exotic suggestions exist, should construct multi from win picks
const noExoticStatus = {
  updatedAt: '2026-03-27T01:00:00.000Z',
  suggestedBets: [
    { meeting: 'Wingatui', race: '5', selection: 'Fast One', type: 'Win', stake: 5.0, reason: 'p=28.0% @ 2.40' },
    { meeting: 'Ellerslie', race: '3', selection: 'Thunder', type: 'Win', stake: 4.0, reason: 'p=22.0% @ 3.50' }
  ]
};
fs.writeFileSync(path.join(multiDir, 'status.json'), JSON.stringify(noExoticStatus, null, 2));

const constructedMulti = buildSelectionFactAnswer('pick me a multi', {}, MULTI_TENANT);
assert.ok(/multi/i.test(constructedMulti) || /Leg/i.test(constructedMulti),
  `Should construct a multi from wins, got: ${constructedMulti.slice(0, 200)}`);
assert.ok(/Wingatui/i.test(constructedMulti) && /Ellerslie/i.test(constructedMulti),
  `Multi should span races, got: ${constructedMulti.slice(0, 200)}`);

// Cleanup
try { fs.rmSync(path.join(ROOT, 'memory', 'tenants', MULTI_TENANT), { recursive: true }); } catch (e) {
  if (e.code !== 'ENOENT') console.warn('cleanup warning:', e.message);
}

console.log('multi handling tests passed');
console.log('next_race_context tests passed');
