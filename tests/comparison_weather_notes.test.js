#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  buildSelectionFactAnswer,
  buildAiContextSummary,
  isMultiQuestion,
  isComparisonQuestion
} = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ── Fixture setup ───────────────────────────────────────────────────
const TENANT_ID = 'comparison_weather_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', TENANT_ID, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-04-05T00:00:00.000Z',
  suggestedBets: [
    { meeting: 'Ellerslie', race: '3', selection: 'Fast Track', type: 'Win', stake: 5.0, reason: 'p=28.5% @ 3.20' },
    { meeting: 'Ellerslie', race: '3', selection: 'Dark Horse', type: 'Win', stake: 3.0, reason: 'p=18.0% @ 5.50' },
    { meeting: 'Ellerslie', race: '5', selection: 'Storm Chaser', type: 'Win', stake: 4.0, reason: 'p=22.0% @ 4.50' },
    { meeting: 'Trentham', race: '2', selection: 'Quick Step', type: 'Win', stake: 3.5, reason: 'p=19.5% @ 5.00' }
  ]
};

const racesFixture = {
  races: [
    {
      key: 'NZ:Ellerslie:R3', country: 'NZ', meeting: 'Ellerslie', race_number: 3,
      description: 'Ellerslie Race 3', distance: 1400, track_condition: 'Soft5',
      runners: [
        { runner_number: 1, name: 'Fast Track', odds: 3.2, barrier: 2, jockey: 'J. Smith', trainer: 'T. Jones', speedmap: 'Leader', last_twenty_starts: '1x2311' },
        { runner_number: 4, name: 'Dark Horse', odds: 5.5, barrier: 7, jockey: 'R. Lee', trainer: 'M. Baker', speedmap: 'Backmarker', last_twenty_starts: '3x1432' },
        { runner_number: 3, name: 'Also Ran', odds: 10.0 }
      ]
    },
    {
      key: 'NZ:Ellerslie:R5', country: 'NZ', meeting: 'Ellerslie', race_number: 5,
      runners: [{ runner_number: 1, name: 'Storm Chaser', odds: 4.5 }]
    },
    {
      key: 'NZ:Trentham:R2', country: 'NZ', meeting: 'Trentham', race_number: 2,
      runners: [{ runner_number: 1, name: 'Quick Step', odds: 5.0 }]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

// ═══════════════════════════════════════════════════════════════════
// PART 1: isMultiQuestion / isComparisonQuestion helpers
// ═══════════════════════════════════════════════════════════════════

assert(isMultiQuestion('pick me a 2 leg multi'), '"2 leg multi" should be multi');
assert(isMultiQuestion('best double today'), '"double" should be multi');
assert(isMultiQuestion('build a parlay'), '"parlay" should be multi');
assert(isMultiQuestion('treble bet'), '"treble" should be multi');
assert(isMultiQuestion('any multis today?'), '"multis" (plural) should be multi');
assert(isMultiQuestion('3-leg accumulator'), '"3-leg accumulator" should be multi');
assert(!isMultiQuestion('who will win race 5?'), 'general question should not be multi');
console.log('✓ isMultiQuestion helper covers all multi terms');

assert(isComparisonQuestion('Fast Track vs Dark Horse'), '"vs" should be comparison');
assert(isComparisonQuestion('Fast Track versus Dark Horse'), '"versus" should be comparison');
assert(isComparisonQuestion('Fast Track against Dark Horse'), '"against" should be comparison');
assert(isComparisonQuestion('how does Fast Track compare to Dark Horse'), '"compare to" should be comparison');
assert(isComparisonQuestion('is Fast Track better than Dark Horse'), '"better than" should be comparison');
assert(isComparisonQuestion('Fast Track or Dark Horse'), '"or" should be comparison');
assert(!isComparisonQuestion('tell me about Fast Track'), 'single runner question should not be comparison');
console.log('✓ isComparisonQuestion helper covers all comparison terms');

// ═══════════════════════════════════════════════════════════════════
// PART 2: Runner-vs-runner comparison in buildSelectionFactAnswer
// ═══════════════════════════════════════════════════════════════════

const cmp1 = buildSelectionFactAnswer('Fast Track vs Dark Horse', {}, TENANT_ID);
assert(cmp1.includes('Fast Track'), 'Comparison should include first runner');
assert(cmp1.includes('Dark Horse'), 'Comparison should include second runner');
assert(/Head-to-head comparison/i.test(cmp1), 'Should be framed as head-to-head');
assert(/Verdict/i.test(cmp1), 'Should include a verdict');
assert(/28\.5%/.test(cmp1), 'Should include model probability for first runner');
assert(/18\.0%/.test(cmp1), 'Should include model probability for second runner');
console.log('✓ "Runner A vs Runner B" produces real comparison with both runners');

const cmp2 = buildSelectionFactAnswer('who is better, Fast Track or Dark Horse?', {}, TENANT_ID);
assert(cmp2.includes('Fast Track') && cmp2.includes('Dark Horse'), '"better than" comparison includes both runners');
assert(/Verdict/i.test(cmp2), '"better than" comparison includes verdict');
console.log('✓ "who is better, A or B" produces comparison');

const cmp3 = buildSelectionFactAnswer('Fast Track against Dark Horse at Ellerslie R3', {}, TENANT_ID);
assert(cmp3.includes('Fast Track') && cmp3.includes('Dark Horse'), '"against" comparison includes both');
assert(cmp3.includes('Ellerslie'), 'Should reference the meeting');
console.log('✓ "A against B" produces comparison');

// Verify verdict picks the higher-probability runner
assert(cmp1.includes('Fast Track is the model'), 'Verdict should prefer Fast Track (28.5% > 18.0%)');
console.log('✓ Verdict correctly picks the higher-probability runner');

// Verify same-race joint likelihood is included
assert(/joint likelihood/i.test(cmp1), 'Same-race comparison should include joint likelihood');
console.log('✓ Same-race comparison includes joint likelihood');

// Verify runner profile details included (barrier, jockey, speedmap)
assert(/gate/i.test(cmp1) || /barrier/i.test(cmp1), 'Comparison should include barrier/gate info');
assert(cmp1.includes('J. Smith') || cmp1.includes('R. Lee'), 'Comparison should include jockey info');
console.log('✓ Comparison includes runner profile details (gate, jockey)');

// Single runner still works as before
const single = buildSelectionFactAnswer('tell me about Fast Track', {}, TENANT_ID);
assert(single.includes('Fast Track'), 'Single runner query should work');
assert(!/Head-to-head/i.test(single), 'Single runner should not be framed as comparison');
console.log('✓ Single runner question still works correctly');

// ═══════════════════════════════════════════════════════════════════
// PART 3: Meeting notes priority in context
// ═══════════════════════════════════════════════════════════════════

const ctxNotes = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  clientContext: {
    userNotes: [
      { text: 'Track is wet, rain all morning', meeting: 'Ellerslie', createdAt: Date.now() },
      { text: 'Wind strong from the north, leaders struggling', meeting: 'Ellerslie', createdAt: Date.now() }
    ]
  },
  upcoming: [{ meeting: 'Ellerslie', race: '3', eta: '14:00' }],
  activity: ['bet placed on Fast Track'],
  maxLength: 5000
});

const notesIdx = ctxNotes.indexOf('User meeting notes');
const activityIdx = ctxNotes.indexOf('Activity');
const upcomingIdx = ctxNotes.indexOf('Upcoming');
assert(notesIdx >= 0, 'Meeting notes should be in context');
if (activityIdx >= 0) assert(notesIdx < activityIdx, 'Meeting notes should come BEFORE Activity');
if (upcomingIdx >= 0) assert(notesIdx < upcomingIdx, 'Meeting notes should come BEFORE Upcoming');
console.log('✓ Meeting notes are prioritized above activity/upcoming in context');

// Verify notes survive truncation when context is tight
const ctxTight = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  clientContext: {
    userNotes: [
      { text: 'Heavy rain expected, track likely to deteriorate', meeting: 'Ellerslie', createdAt: Date.now() }
    ]
  },
  upcoming: [{ meeting: 'Ellerslie', race: '3', eta: '14:00' }],
  activity: ['bet placed', 'another action', 'third action'],
  maxLength: 400
});
// With tight limit, notes should survive while activity/upcoming get truncated
assert(ctxTight.includes('User meeting notes') || ctxTight.includes('rain'), 'Meeting notes should survive tight context limits');
console.log('✓ Meeting notes survive tight context limits');

// ═══════════════════════════════════════════════════════════════════
// PART 4: Weather in meeting notes
// ═══════════════════════════════════════════════════════════════════

const ctxWeather = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  clientContext: {
    userNotes: [
      { text: 'Raining heavily, track downgraded to Heavy8', meeting: 'Ellerslie', createdAt: Date.now() },
      { text: 'Wind 30km/h from the south', meeting: 'Ellerslie', createdAt: Date.now() }
    ]
  },
  maxLength: 5000
});
assert(ctxWeather.includes('Raining heavily'), 'Weather note should be in context');
assert(ctxWeather.includes('Wind 30km/h'), 'Wind note should be in context');
assert(ctxWeather.includes('Ellerslie'), 'Meeting tag should be present with weather notes');
console.log('✓ Weather information from meeting notes appears in context');

// Verify loveracing weather data appears in context when available
const ctxLoveracing = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  clientContext: {
    selections: [{ meeting: 'Ellerslie', race: '3', selection: 'Fast Track' }]
  },
  races: [{
    meeting: 'Ellerslie', race_number: 3, description: 'Test Race',
    distance: 1400, track_condition: 'Heavy8',
    loveracing: { available: true, weather: 'Rain, 15°C, Wind SW 25km/h' },
    runners: [{ name: 'Fast Track', barrier: 2, odds: 3.2 }]
  }],
  maxLength: 10000
});
assert(ctxLoveracing.includes('loveracingWeather') || ctxLoveracing.includes('Rain'), 'Loveracing weather data should appear in context');
console.log('✓ Loveracing weather data appears in race context');

console.log('\ncomparison_weather_notes tests passed');
