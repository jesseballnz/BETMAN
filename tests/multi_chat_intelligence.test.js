#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildSelectionFactAnswer, buildAiContextSummary } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ── Test fixture setup ──────────────────────────────────────────────
const TENANT_ID = 'multi_chat_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', TENANT_ID, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-04-05T00:00:00.000Z',
  suggestedBets: [
    { meeting: 'Ellerslie', race: '3', selection: 'Fast Track', type: 'Win', stake: 5.0, reason: 'p=28.5% @ 3.20', aiWinProb: 28.5 },
    { meeting: 'Ellerslie', race: '5', selection: 'Dark Horse', type: 'Win', stake: 4.0, reason: 'p=22.0% @ 4.50', aiWinProb: 22.0 },
    { meeting: 'Trentham', race: '2', selection: 'Quick Step', type: 'Win', stake: 3.5, reason: 'p=19.5% @ 5.00', aiWinProb: 19.5 },
    { meeting: 'Trentham', race: '6', selection: 'Storm Chaser', type: 'Win', stake: 4.5, reason: 'p=24.0% @ 3.80', aiWinProb: 24.0 },
    { meeting: 'Ellerslie', race: '3', selection: 'Second Best', type: 'Win', stake: 2.0, reason: 'p=15.0% @ 6.00', aiWinProb: 15.0 },
    { meeting: 'Ellerslie', race: '5', selection: 'Top Pick / Dark Horse / Runner Up', type: 'Top3', stake: 0.50, reason: 'Top-3 profile from adjusted probabilities' }
  ]
};

const racesFixture = {
  races: [
    {
      key: 'NZ:Ellerslie:R3', country: 'NZ', meeting: 'Ellerslie', race_number: 3,
      description: 'Ellerslie Race 3', start_time_nz: '14:00:00 NZDT',
      runners: [
        { runner_number: 1, name: 'Fast Track', odds: 3.2 },
        { runner_number: 2, name: 'Second Best', odds: 6.0 },
        { runner_number: 3, name: 'Also Ran', odds: 10.0 }
      ]
    },
    {
      key: 'NZ:Ellerslie:R5', country: 'NZ', meeting: 'Ellerslie', race_number: 5,
      description: 'Ellerslie Race 5', start_time_nz: '15:00:00 NZDT',
      runners: [
        { runner_number: 1, name: 'Dark Horse', odds: 4.5 },
        { runner_number: 2, name: 'Runner Up', odds: 5.5 }
      ]
    },
    {
      key: 'NZ:Trentham:R2', country: 'NZ', meeting: 'Trentham', race_number: 2,
      description: 'Trentham Race 2', start_time_nz: '13:30:00 NZDT',
      runners: [
        { runner_number: 1, name: 'Quick Step', odds: 5.0 },
        { runner_number: 2, name: 'Slow Poke', odds: 8.0 }
      ]
    },
    {
      key: 'NZ:Trentham:R6', country: 'NZ', meeting: 'Trentham', race_number: 6,
      description: 'Trentham Race 6', start_time_nz: '16:00:00 NZDT',
      runners: [
        { runner_number: 1, name: 'Storm Chaser', odds: 3.8 }
      ]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

// ── Test 1: "2 leg multi" triggers multi fallback ───────────────────
const a1 = buildSelectionFactAnswer('pick me a 2 leg multi', {}, TENANT_ID);
assert(a1.includes('Multi recommendation'), `Expected "Multi recommendation" in answer: ${a1.slice(0, 200)}`);
assert(a1.includes('Leg 1'), 'Expected Leg 1 in multi answer');
assert(a1.includes('Leg 2'), 'Expected Leg 2 in multi answer');
assert(/2-leg multi/i.test(a1), 'Expected 2-leg multi description');
console.log('✓ "2 leg multi" generates proper multi recommendation');

// ── Test 2: "best double today" triggers multi ──────────────────────
const a2 = buildSelectionFactAnswer('best double today', {}, TENANT_ID);
assert(a2.includes('Multi recommendation') || a2.includes('Leg 1'), `"double" should trigger multi: ${a2.slice(0, 200)}`);
console.log('✓ "best double today" triggers multi recommendation');

// ── Test 3: "parlay" triggers multi ─────────────────────────────────
const a3 = buildSelectionFactAnswer('build me a parlay', {}, TENANT_ID);
assert(a3.includes('Multi recommendation') || a3.includes('Leg 1'), `"parlay" should trigger multi: ${a3.slice(0, 200)}`);
console.log('✓ "parlay" triggers multi recommendation');

// ── Test 4: "treble" triggers multi ─────────────────────────────────
const a4 = buildSelectionFactAnswer('give me a treble', {}, TENANT_ID);
assert(a4.includes('Multi recommendation') || a4.includes('Leg 1'), `"treble" should trigger multi: ${a4.slice(0, 200)}`);
console.log('✓ "treble" triggers multi recommendation');

// ── Test 5: "accumulator" triggers multi ────────────────────────────
const a5 = buildSelectionFactAnswer('put together an accumulator', {}, TENANT_ID);
assert(a5.includes('Multi recommendation') || a5.includes('Leg 1'), `"accumulator" should trigger multi: ${a5.slice(0, 200)}`);
console.log('✓ "accumulator" triggers multi recommendation');

// ── Test 6: "combo" triggers multi ──────────────────────────────────
const a6 = buildSelectionFactAnswer('any good combo bets?', {}, TENANT_ID);
assert(a6.includes('Multi recommendation') || a6.includes('Leg 1'), `"combo" should trigger multi: ${a6.slice(0, 200)}`);
console.log('✓ "combo" triggers multi recommendation');

// ── Test 7: Multi answer includes combined odds ─────────────────────
const a7 = buildSelectionFactAnswer('best 2 leg multi', {}, TENANT_ID);
assert(/Combined multi odds/i.test(a7) || /\$\d+\.\d+/i.test(a7), `Multi should include combined odds: ${a7.slice(0, 400)}`);
console.log('✓ Multi answer includes combined odds');

// ── Test 8: Multi answer includes joint probability ─────────────────
assert(/Joint win probability|Combined multi probability/i.test(a7), `Multi should include joint probability: ${a7.slice(0, 400)}`);
console.log('✓ Multi answer includes joint win probability');

// ── Test 9: Multi answer includes value assessment ──────────────────
assert(/value|overlay|underlay|Fair price/i.test(a7), `Multi should include value assessment: ${a7.slice(0, 500)}`);
console.log('✓ Multi answer includes value assessment');

// ── Test 10: "3 leg multi" picks 3 legs ─────────────────────────────
const a10 = buildSelectionFactAnswer('build a 3 leg multi', {}, TENANT_ID);
assert(a10.includes('Leg 3'), `Expected 3 legs: ${a10.slice(0, 400)}`);
assert(/3-leg multi/i.test(a10), 'Expected 3-leg label');
console.log('✓ "3 leg multi" picks 3 legs correctly');

// ── Test 11: Cross-race multi pairs include odds in context ─────────
const crossPairs = [
  {
    meeting: 'Ellerslie', race: '3', runnerA: 'Fast Track',
    meetingB: 'Trentham', raceB: '2', runnerB: 'Quick Step',
    winA: 28.5, winB: 19.5, jointLikelihood: 5.6,
    oddsA: 3.20, oddsB: 5.00,
    method: 'cross-race≈pA*pB/100'
  }
];
const ctx = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: crossPairs,
  maxLength: 5000
});
assert(ctx.includes('Joint likelihoods'), 'Cross-race pairs should appear in context');
assert(ctx.includes('joint 5.6%'), 'Joint likelihood should be present');
assert(ctx.includes('$3.20'), 'Odds for leg A should appear in context');
assert(ctx.includes('$5.00'), 'Odds for leg B should appear in context');
assert(ctx.includes('$16.00'), 'Combined odds ($3.20 × $5.00 = $16.00) should appear');
console.log('✓ Cross-race multi pairs include odds in context summary');

// ── Test 12: Joint likelihoods appear BEFORE activity/upcoming ──────
const ctxPriority = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: crossPairs,
  upcoming: [{ meeting: 'Ellerslie', race: '3', eta: '14:00' }],
  activity: ['bet placed'],
  maxLength: 5000
});
const jointIdx = ctxPriority.indexOf('Joint likelihoods');
const activityIdx = ctxPriority.indexOf('Activity');
const upcomingIdx = ctxPriority.indexOf('Upcoming');
assert(jointIdx >= 0, 'Joint likelihoods should be in context');
if (activityIdx >= 0) assert(jointIdx < activityIdx, 'Joint likelihoods should come before Activity');
if (upcomingIdx >= 0) assert(jointIdx < upcomingIdx, 'Joint likelihoods should come before Upcoming');
console.log('✓ Joint likelihoods prioritized above activity/upcoming in context');

// ── Test 13: Cross-race pairs computed from odds-only bets ──────────
// Status with bets that have no aiWinProb but have odds in reason
const oddsOnlyTenant = 'multi_chat_odds_only';
const oddsOnlyDir = path.join(ROOT, 'memory', 'tenants', oddsOnlyTenant, 'frontend-data');
fs.mkdirSync(oddsOnlyDir, { recursive: true });

const oddsOnlyStatus = {
  updatedAt: '2026-04-05T00:00:00.000Z',
  suggestedBets: [
    { meeting: 'Riccarton', race: '1', selection: 'Alpha', type: 'Win', stake: 4.0, reason: 'p=25.0% @ 3.50' },
    { meeting: 'Riccarton', race: '4', selection: 'Beta', type: 'Win', stake: 3.0, reason: 'p=20.0% @ 5.00' }
  ]
};
const oddsOnlyRaces = {
  races: [
    { key: 'NZ:Riccarton:R1', country: 'NZ', meeting: 'Riccarton', race_number: 1, runners: [{ runner_number: 1, name: 'Alpha', odds: 3.5 }] },
    { key: 'NZ:Riccarton:R4', country: 'NZ', meeting: 'Riccarton', race_number: 4, runners: [{ runner_number: 1, name: 'Beta', odds: 5.0 }] }
  ]
};

fs.writeFileSync(path.join(oddsOnlyDir, 'status.json'), JSON.stringify(oddsOnlyStatus, null, 2));
fs.writeFileSync(path.join(oddsOnlyDir, 'races.json'), JSON.stringify(oddsOnlyRaces, null, 2));

const a13 = buildSelectionFactAnswer('best 2 leg multi today', {}, oddsOnlyTenant);
assert(a13.includes('Multi recommendation'), `Odds-only bets should produce multi: ${a13.slice(0, 300)}`);
assert(a13.includes('Alpha') && a13.includes('Beta'), 'Both legs should appear');
console.log('✓ Multi recommendation works with odds-only bets (no aiWinProb)');

// ── Test 14: 6 joint likelihood rows shown (not just 3) ─────────────
const manyPairs = Array.from({ length: 8 }, (_, i) => ({
  meeting: 'M', race: String(i + 1), runnerA: `RunnerA${i}`,
  meetingB: 'N', raceB: String(i + 2), runnerB: `RunnerB${i}`,
  winA: 30, winB: 25, jointLikelihood: 7.5 - i * 0.5,
  method: 'cross-race≈pA*pB/100'
}));
const ctxMany = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: manyPairs,
  maxLength: 10000
});
// Count how many pairs appear (each has a unique runnerA name)
let pairsShown = 0;
for (let i = 0; i < 8; i++) {
  if (ctxMany.includes(`RunnerA${i}`)) pairsShown++;
}
assert(pairsShown >= 6, `Expected at least 6 pairs shown, got ${pairsShown}`);
console.log(`✓ Context shows ${pairsShown} joint likelihood pairs (increased from 3)`);

console.log('\nmulti_chat_intelligence tests passed');
