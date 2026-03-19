#!/usr/bin/env node
/*
  BETMAN Consistency Harness
  Usage: node frontend/scripts/consistency-harness.js
*/

function validateDecisionSignals(signals = {}) {
  const issues = [];
  const winEdge = Number(signals.recommendedWinEdge);
  if (signals.recommended && (!Number.isFinite(winEdge) || winEdge < 0)) {
    issues.push('recommended_negative_edge');
  }
  const odds = Number(signals.oddsRunnerOdds);
  const oddsEdge = Number(signals.oddsRunnerEdge);
  if (signals.oddsRunner && (!Number.isFinite(odds) || odds < 6 || !Number.isFinite(oddsEdge) || oddsEdge <= 0)) {
    issues.push('odds_runner_invalid_profile');
  }
  const ewPlace = Number(signals.ewPlaceProb);
  if (signals.ew && Number.isFinite(ewPlace) && (ewPlace <= 0 || ewPlace >= 0.9)) {
    issues.push('ew_degenerate_place_prob');
  }
  return issues;
}

const fixtures = [
  {
    name: 'valid profile',
    signals: {
      recommended: 'Horse A',
      recommendedWinEdge: 2.1,
      oddsRunner: 'Horse B',
      oddsRunnerOdds: 8.5,
      oddsRunnerEdge: 1.2,
      ew: 'Horse C',
      ewPlaceProb: 0.42
    },
    expectPass: true
  },
  {
    name: 'bad sample from production regression',
    signals: {
      recommended: 'So Fear',
      recommendedWinEdge: -4.1,
      oddsRunner: 'Incandescent',
      oddsRunnerOdds: 3.1,
      oddsRunnerEdge: -5.4,
      ew: 'So Fear',
      ewPlaceProb: 1.0
    },
    expectPass: false
  }
];

let failures = 0;
for (const t of fixtures) {
  const issues = validateDecisionSignals(t.signals);
  const pass = issues.length === 0;
  const ok = t.expectPass ? pass : !pass;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${t.name}${issues.length ? ` -> ${issues.join(', ')}` : ''}`);
}

if (failures > 0) {
  console.error(`\nConsistency harness failed: ${failures} test(s)`);
  process.exit(1);
}
console.log('\nConsistency harness passed.');
