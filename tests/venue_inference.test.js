#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { inferMeetingFromQuestion, buildSelectionFactAnswer, buildAiContextSummary } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

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
assert.strictEqual(r2.mentioned, 'riccarton', 'should detect riccarton as known venue');
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
assert.strictEqual(r6.mentioned, 'riccarton');
assert.deepStrictEqual(r6.matched, []);
assert.deepStrictEqual(r6.available, []);

// 7) Multi-word venue (Te Aroha is a known venue)
const racesWithTeAroha = [{ meeting: 'Te Aroha', race_number: 1 }];
const r7 = inferMeetingFromQuestion('What about Te Aroha R1?', racesWithTeAroha);
assert.strictEqual(r7.mentioned, 'Te Aroha');
assert.deepStrictEqual(r7.matched, ['Te Aroha']);

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

console.log('venue_inference tests passed');
