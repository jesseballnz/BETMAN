#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { inferMeetingFromQuestion, inferExplicitRaceContext, buildSelectionFactAnswer, buildAiContextSummary, isLiveRaceEntry, FINISHED_RACE_STATUSES } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ─── inferMeetingFromQuestion ───────────────────────────────────────────────

const races = [
  { meeting: 'Wingatui', race_number: 1 },
  { meeting: 'Wingatui', race_number: 2 },
  { meeting: 'Ellerslie', race_number: 3 },
  { meeting: 'Caulfield', race_number: 4 }
];

// 1) Matches a venue present in races
const r1 = inferMeetingFromQuestion('Give me the best bet from Wingatui R1', races);
assert.strictEqual(r1.mentioned, 'Wingatui', 'should detect Wingatui');
assert.deepStrictEqual(r1.matched, ['Wingatui']);
assert(r1.available.includes('Wingatui'));

// 2) Matches a known venue NOT in today's races (Riccarton scenario)
const r2 = inferMeetingFromQuestion('Give me the strongest betting angle from the next Riccarton race.', races);
assert.strictEqual(r2.mentioned, 'Riccarton', 'should detect Riccarton as known venue (title case)');
assert.deepStrictEqual(r2.matched, [], 'no match in available races');
assert(r2.available.includes('Wingatui'));
assert(r2.available.includes('Ellerslie'));

// 3) No venue mentioned → null
const r3 = inferMeetingFromQuestion('What is the best bet today?', races);
assert.strictEqual(r3.mentioned, null);
assert.deepStrictEqual(r3.matched, []);

// 4) Case insensitive matching
const r4 = inferMeetingFromQuestion('Show me caulfield races', races);
assert.strictEqual(r4.mentioned, 'Caulfield');
assert.deepStrictEqual(r4.matched, ['Caulfield']);

// 5) Empty question
const r5 = inferMeetingFromQuestion('', races);
assert.strictEqual(r5.mentioned, null);

// 6) Empty races
const r6 = inferMeetingFromQuestion('Give me Riccarton tips', []);
assert.strictEqual(r6.mentioned, 'Riccarton');
assert.deepStrictEqual(r6.matched, []);
assert.deepStrictEqual(r6.available, []);

// 7) Multi-word venue (Te Aroha is a known venue)
const racesWithTeAroha = [{ meeting: 'Te Aroha', race_number: 1 }];
const r7 = inferMeetingFromQuestion('What about Te Aroha R1?', racesWithTeAroha);
assert.strictEqual(r7.mentioned, 'Te Aroha');
assert.deepStrictEqual(r7.matched, ['Te Aroha']);

// 7b) Explicit race anchoring should keep meeting+r race paired correctly
const raceAnchor = inferExplicitRaceContext('Analyse Ellerslie R1 for me', [
  { meeting: 'Ellerslie', race_number: 1, description: 'ELL R1' },
  { meeting: 'Riverton', race_number: 1, description: 'RIV R1' }
]);
assert.deepStrictEqual(raceAnchor, {
  meeting: 'Ellerslie',
  raceNumber: '1',
  raceName: 'ELL R1',
  anchorType: 'explicit-race'
});

// 7c) Fallback payload meeting/race should also anchor explicitly
const payloadAnchor = inferExplicitRaceContext('Who wins race 1?', [
  { meeting: 'Ellerslie', race_number: 1, description: 'ELL R1' },
  { meeting: 'Riverton', race_number: 1, description: 'RIV R1' }
], 'Ellerslie', '1');
assert.deepStrictEqual(payloadAnchor, {
  meeting: 'Ellerslie',
  raceNumber: '1',
  raceName: 'ELL R1',
  anchorType: 'explicit-race'
});

// 7d) Explicit question context must override stale fallback payload context
const overrideAnchor = inferExplicitRaceContext('Analyse Riverton R1 for me', [
  { meeting: 'Ellerslie', race_number: 1, description: 'ELL R1' },
  { meeting: 'Riverton', race_number: 1, description: 'RIV R1' }
], 'Ellerslie', '1');
assert.deepStrictEqual(overrideAnchor, {
  meeting: 'Riverton',
  raceNumber: '1',
  raceName: 'RIV R1',
  anchorType: 'explicit-race'
});

// ─── buildSelectionFactAnswer: venue-aware ──────────────────────────────────

const VENUE_TENANT = 'venue_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', VENUE_TENANT, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-03-27T01:00:00.000Z',
  suggestedBets: [
    { meeting: 'Wingatui', race: '6', selection: 'Strong', type: 'Win', stake: 3.5, reason: 'p=18.9% @ 3.60' },
    { meeting: 'Wingatui', race: '6', selection: 'Imperative', type: 'Win', stake: 2.0, reason: 'p=14.2% @ 4.20' }
  ]
};

const racesFixture = {
  races: [
    {
      meeting: 'Wingatui',
      race_number: 6,
      description: 'MORE FM',
      runners: [
        { runner_number: 1, name: 'Strong', odds: 3.60 },
        { runner_number: 2, name: 'Imperative', odds: 4.20 }
      ]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

// 8) Asking about a venue with no races should return "no races" message
const a1 = buildSelectionFactAnswer('Give me the strongest betting angle from the next Riccarton race.', {}, VENUE_TENANT);
assert(/no races at riccarton/i.test(a1), `Expected "no races at riccarton" but got: ${a1.slice(0, 100)}`);
assert(/wingatui/i.test(a1), 'Should suggest Wingatui as available');

// 9) Asking about a venue WITH races should work normally (not say "no races")
const a2 = buildSelectionFactAnswer('Who is the top pick at Wingatui?', {}, VENUE_TENANT);
assert(!/no races/i.test(a2), 'Should NOT say no races for Wingatui');
assert(/Strong/i.test(a2) || /Wingatui/i.test(a2), 'Should mention Strong or Wingatui');

// ─── buildAiContextSummary: venueNote ───────────────────────────────────────

// 10) venueNote should appear in summary output
const summary = buildAiContextSummary({
  venueNote: 'IMPORTANT: No races at Riccarton today. Available: Wingatui.',
  status: { updatedAt: 'now', apiStatus: 'ok' },
  maxLength: 2000
});
assert(summary.includes('No races at Riccarton'), 'venueNote should be in summary');

// 11) No venueNote → summary does not mention it
const summaryNoVenue = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  maxLength: 2000
});
assert(!summaryNoVenue.includes('No races at Riccarton'), 'should not include venue note when not provided');

// Cleanup
try { fs.rmSync(path.join(ROOT, 'memory', 'tenants', VENUE_TENANT), { recursive: true }); } catch {}

// ─── FINISHED_RACE_STATUSES constant ────────────────────────────────────────

// 12) FINISHED_RACE_STATUSES is exported and contains expected values
assert.ok(FINISHED_RACE_STATUSES instanceof Set, 'should be a Set');
assert.ok(FINISHED_RACE_STATUSES.has('final'));
assert.ok(FINISHED_RACE_STATUSES.has('closed'));
assert.ok(FINISHED_RACE_STATUSES.has('abandoned'));
assert.ok(FINISHED_RACE_STATUSES.has('resulted'));
assert.ok(!FINISHED_RACE_STATUSES.has('open'), 'open should not be a finished status');

// ─── inferMeetingFromQuestion: finished races excluded ──────────────────────

// 13) When all races at a venue are finished, venue should not match in available races
const racesWithFinished = [
  { meeting: 'Wingatui', race_number: 1, race_status: 'Final' },
  { meeting: 'Wingatui', race_number: 2, race_status: 'Resulted' },
  { meeting: 'Ellerslie', race_number: 3, race_status: 'Open' }
];
const liveOnly = racesWithFinished.filter(r => !FINISHED_RACE_STATUSES.has(String(r.race_status || '').toLowerCase()));
const r8 = inferMeetingFromQuestion('Give me the best bet from Wingatui', liveOnly);
assert.deepStrictEqual(r8.matched, [], 'Wingatui should not match in available races when all finished');
assert.ok(!r8.available.includes('Wingatui'), 'Wingatui should not be in available');
assert.ok(r8.available.includes('Ellerslie'), 'Ellerslie should be available');

// 14) buildSelectionFactAnswer: finished venue returns "no races" message
const FINISHED_TENANT = 'finished_venue_test';
const finishedDir = path.join(ROOT, 'memory', 'tenants', FINISHED_TENANT, 'frontend-data');
fs.mkdirSync(finishedDir, { recursive: true });

const finishedStatus = {
  updatedAt: '2026-03-27T01:00:00.000Z',
  suggestedBets: [
    { meeting: 'Ellerslie', race: '3', selection: 'Thunder', type: 'Win', stake: 4.0, reason: 'p=22.0% @ 3.50' }
  ]
};
const finishedRaces = {
  races: [
    { meeting: 'Wingatui', race_number: 1, race_status: 'Final', description: 'R1', runners: [{ runner_number: 1, name: 'OldRunner', odds: 5.0 }] },
    { meeting: 'Wingatui', race_number: 2, race_status: 'Resulted', description: 'R2', runners: [{ runner_number: 1, name: 'OldRunner2', odds: 6.0 }] },
    { meeting: 'Ellerslie', race_number: 3, race_status: 'Open', description: 'R3', runners: [{ runner_number: 1, name: 'Thunder', odds: 3.50 }] }
  ]
};
fs.writeFileSync(path.join(finishedDir, 'status.json'), JSON.stringify(finishedStatus, null, 2));
fs.writeFileSync(path.join(finishedDir, 'races.json'), JSON.stringify(finishedRaces, null, 2));

const a3 = buildSelectionFactAnswer('Give me the next favourite at Wingatui', {}, FINISHED_TENANT);
assert(/no races at wingatui/i.test(a3), `Expected "no races at Wingatui" for finished venue, got: ${a3.slice(0, 200)}`);
assert(/ellerslie/i.test(a3), 'Should suggest Ellerslie as alternative');

try { fs.rmSync(path.join(ROOT, 'memory', 'tenants', FINISHED_TENANT), { recursive: true }); } catch {}

console.log('finished race filtering tests passed');

// ─── isLiveRaceEntry ────────────────────────────────────────────────────────

const allRacesForFilter = [
  { meeting: 'Wingatui', race_number: '1', race_status: 'Final' },
  { meeting: 'Wingatui', race_number: '4', race_status: 'resulted' },
  { meeting: 'Wingatui', race_number: '6', race_status: 'open' },
  { meeting: 'Ellerslie', race_number: '3', race_status: 'closed' },
  { meeting: 'Ellerslie', race_number: '5', race_status: 'abandoned' }
];

// 15) Entries for finished races should return false
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: '1' }, allRacesForFilter), false, 'Final race should not be live');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: '4' }, allRacesForFilter), false, 'Resulted race should not be live');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Ellerslie', race: '3' }, allRacesForFilter), false, 'Closed race should not be live');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Ellerslie', race: '5' }, allRacesForFilter), false, 'Abandoned race should not be live');

// 16) Entries for open races should return true
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: '6' }, allRacesForFilter), true, 'Open race should be live');

// 17) Entries with no matching race in allRaces are kept (safe default)
assert.strictEqual(isLiveRaceEntry({ meeting: 'Randwick', race: '1' }, allRacesForFilter), true, 'Unknown venue should be treated as live');

// 18) Handles R-prefix in race field
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: 'R1' }, allRacesForFilter), false, 'R-prefix should still match finished race');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: 'R6' }, allRacesForFilter), true, 'R-prefix should still match open race');

// 19) Handles race_number field instead of race
assert.strictEqual(isLiveRaceEntry({ meeting: 'Ellerslie', race_number: '3' }, allRacesForFilter), false, 'race_number field should work for finished race');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race_number: '6' }, allRacesForFilter), true, 'race_number field should work for open race');

// 20) Case-insensitive meeting matching
assert.strictEqual(isLiveRaceEntry({ meeting: 'WINGATUI', race: '1' }, allRacesForFilter), false, 'Case-insensitive meeting should match');

// 21) Edge cases: missing/malformed fields treated as live (safe default)
assert.strictEqual(isLiveRaceEntry({}, allRacesForFilter), true, 'Empty entry should be treated as live');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui' }, allRacesForFilter), true, 'Entry with no race field should be treated as live');
assert.strictEqual(isLiveRaceEntry({ race: '1' }, allRacesForFilter), true, 'Entry with no meeting field should be treated as live');
assert.strictEqual(isLiveRaceEntry({ meeting: null, race: null }, allRacesForFilter), true, 'Null fields should be treated as live');
assert.strictEqual(isLiveRaceEntry({ meeting: 'Wingatui', race: '1' }, []), true, 'Empty allRaces should treat entry as live');

// 21) buildAiContextSummary should not include interesting runners or movers from finished races
const summaryWithFinished = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  interesting: [
    { meeting: 'Wingatui', race: '1', runner: 'FinishedRunner', odds: 3.5, reason: 'looks good' },
    { meeting: 'Wingatui', race: '6', runner: 'LiveRunner', odds: 4.0, reason: 'strong form' }
  ].filter(s => isLiveRaceEntry(s, allRacesForFilter)),
  marketMovers: [
    { meeting: 'Ellerslie', race: '3', runner: 'ClosedMover', pctMove: -10, fromOdds: 5.0, toOdds: 4.0 },
    { meeting: 'Wingatui', race: '6', runner: 'LiveMover', pctMove: -5, fromOdds: 3.0, toOdds: 2.5 }
  ].filter(s => isLiveRaceEntry(s, allRacesForFilter)),
  maxLength: 5000
});
assert(!summaryWithFinished.includes('FinishedRunner'), 'Interesting runner from finished race should be excluded from context');
assert(summaryWithFinished.includes('LiveRunner'), 'Interesting runner from live race should be included');
assert(!summaryWithFinished.includes('ClosedMover'), 'Market mover from closed race should be excluded from context');
assert(summaryWithFinished.includes('LiveMover'), 'Market mover from live race should be included');

console.log('isLiveRaceEntry tests passed');

console.log('venue_inference tests passed');
