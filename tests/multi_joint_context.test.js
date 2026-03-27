#!/usr/bin/env node
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildAiContextSummary } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ── Same-race joint rows (existing behaviour) ───────────────────────
const sameRaceRows = [
  { meeting: 'Wingatui', race: '5', runnerA: 'Flash', runnerB: 'Dash', winA: 30.0, winB: 25.0, jointLikelihood: 6.9, method: 'joint≈(pA*pB/100)*0.92' }
];
const ctx1 = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: sameRaceRows,
  maxLength: 5000
});
assert(ctx1.includes('Joint likelihoods'), 'same-race jointRows should appear in context');
assert(ctx1.includes('Wingatui R5 Flash+Dash'), 'same-race pair should use compact format');
assert(ctx1.includes('joint 6.9%'), 'joint likelihood value should be present');
assert(ctx1.includes('wins 30.0%/25.0%'), 'individual win probabilities should appear');

// ── Cross-race joint rows (new multi behaviour) ─────────────────────
const crossRaceRows = [
  { meeting: 'Wingatui', race: '5', runnerA: 'Flash', meetingB: 'Toowoomba', raceB: '3', runnerB: 'Storm', winA: 30.0, winB: 40.0, jointLikelihood: 12.0, method: 'cross-race≈pA*pB/100' }
];
const ctx2 = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: crossRaceRows,
  maxLength: 5000
});
assert(ctx2.includes('Joint likelihoods'), 'cross-race jointRows should appear in context');
assert(ctx2.includes('Wingatui R5 Flash'), 'cross-race leg A meeting/race/runner should appear');
assert(ctx2.includes('Toowoomba R3 Storm'), 'cross-race leg B meeting/race/runner should appear');
assert(ctx2.includes('joint 12.0%'), 'cross-race joint likelihood value should be present');
assert(ctx2.includes('wins 30.0%/40.0%'), 'cross-race individual win probs should appear');

// ── Empty joint rows should not add a line ──────────────────────────
const ctx3 = buildAiContextSummary({
  status: { updatedAt: 'now', apiStatus: 'ok' },
  jointRows: [],
  maxLength: 5000
});
assert(!ctx3.includes('Joint likelihoods'), 'empty jointRows should not produce a section');

console.log('multi_joint_context tests passed');
