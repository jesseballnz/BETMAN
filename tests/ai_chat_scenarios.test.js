#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildSelectionFactAnswer, enforceDecisionAnswerFormat, aiAnswerRespectsSelections } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

const TENANT_ID = 'ai_chat_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', TENANT_ID, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-03-05T04:00:00.000Z',
  suggestedBets: [
    { meeting: 'Tauherenikau', race: '7', selection: 'Not So Unusual', type: 'Win', stake: 4.2, reason: 'p=26.2% @ 3.0' },
    { meeting: 'Tauherenikau', race: '7', selection: 'Poukawa', type: 'Win', stake: 2.8, reason: 'p=19.4% @ 4.2' },
    { meeting: 'Tauherenikau', race: '8', selection: 'The Espy', type: 'Win', stake: 4.2, reason: 'p=25.0% @ 3.2' },
    { meeting: 'Tauherenikau', race: '8', selection: 'Uncle Ken / Plain Sailing / Say I Do', type: 'Top3', stake: 0.63, reason: 'Top-3 profile from adjusted win probabilities' }
  ],
  interestingRunners: [
    { meeting: 'Tauherenikau', race: '7', runner: 'Not So Unusual', reason: 'plan Win @ 3.0', eta: 'in 23m', odds: 3.0 }
  ]
};

const racesFixture = {
  races: [
    {
      key: 'NZ:Tauherenikau:R7',
      country: 'NZ',
      meeting: 'Tauherenikau',
      race_number: 7,
      description: 'Tauherenikau Race 7',
      start_time_nz: '16:40:00 NZDT',
      runners: [
        { runner_number: 1, name: 'Not So Unusual', odds: 3.0 },
        { runner_number: 2, name: 'Poukawa', odds: 4.2 },
        { runner_number: 3, name: 'Psyclone', odds: 6.5 }
      ]
    },
    {
      key: 'NZ:Tauherenikau:R8',
      country: 'NZ',
      meeting: 'Tauherenikau',
      race_number: 8,
      description: 'Tauherenikau R8',
      start_time_nz: '17:15:00 NZDT',
      runners: [
        { runner_number: 1, name: 'The Espy', odds: 3.1 },
        { runner_number: 2, name: 'Uncle Ken', odds: 6.2 },
        { runner_number: 3, name: 'Plain Sailing', odds: 7.0 }
      ]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

// Batch 1: core real-world prompts
const a1 = buildSelectionFactAnswer('Why do we like Not So Unusual at Tauherenikau R7?', {}, TENANT_ID);
assert(a1.includes('Not So Unusual'));
assert(a1.includes('Tauherenikau Race 7'));
assert(/26\.2%/.test(a1));

const ctxSameRace = {
  selections: [
    { meeting: 'Tauherenikau', race: '7', selection: 'Not So Unusual' },
    { meeting: 'Tauherenikau', race: '7', selection: 'Poukawa' }
  ],
  selectionCount: 2
};
const a2 = buildSelectionFactAnswer('Break down this dragged basket as same-race multi.', ctxSameRace, TENANT_ID);
assert(/Same-race multi context/i.test(a2));
assert(a2.includes('Not So Unusual') && a2.includes('Poukawa'));
assert(/joint likelihood/i.test(a2));

const a3 = buildSelectionFactAnswer('What is the read for R8?', {}, TENANT_ID);
assert(/R8 context only/i.test(a3));
assert(a3.includes('The Espy'));

const a4 = buildSelectionFactAnswer('Do we have any multis or exotic bets today?', {}, TENANT_ID);
assert(/leading exotic/i.test(a4));
assert(/Top-3 profile/i.test(a4));

// Batch 2: additional scenarios + guardrails
const ctxMultiRace = {
  selections: [
    { meeting: 'Tauherenikau', race: '7', selection: 'Not So Unusual' },
    { meeting: 'Tauherenikau', race: '8', selection: 'The Espy' }
  ],
  selectionCount: 2
};
const a5 = buildSelectionFactAnswer('Analyze this dragged basket as a multi.', ctxMultiRace, TENANT_ID);
assert(/Multi-race context/i.test(a5));
assert(a5.includes('Tauherenikau R7') && a5.includes('Tauherenikau R8'));

const a6 = buildSelectionFactAnswer('Who is the top pick right now?', {}, TENANT_ID);
assert(a6.includes('Not So Unusual'));
assert(/Next in line:/i.test(a6));

const formatted = enforceDecisionAnswerFormat('Raw output without structure');
['Verdict:', 'Market edge:', 'Risk:', 'Pass conditions:'].forEach(token => {
  assert(formatted.includes(token));
});

const payload = { selections: [{ selection: '1. Not So Unusual' }, { selection: '2. Poukawa' }] };
assert(aiAnswerRespectsSelections('Not So Unusual edges Poukawa late.', payload));
assert(!aiAnswerRespectsSelections('Only Not So Unusual mentioned.', payload));

// Empty-state scenario on separate tenant
const emptyTenant = 'ai_chat_test_empty';
const emptyDir = path.join(ROOT, 'memory', 'tenants', emptyTenant, 'frontend-data');
fs.mkdirSync(emptyDir, { recursive: true });
fs.writeFileSync(path.join(emptyDir, 'status.json'), JSON.stringify({ suggestedBets: [] }, null, 2));
const a7 = buildSelectionFactAnswer('Any picks loaded?', {}, emptyTenant);
assert(/I do not have any current selections loaded yet/i.test(a7));

console.log('ai_chat scenarios tests passed');
