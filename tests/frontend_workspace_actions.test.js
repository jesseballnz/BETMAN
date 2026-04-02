#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

function extractBetween(startMarker, endMarker) {
  const start = appJs.indexOf(startMarker);
  if (start === -1) throw new Error(`Could not find ${startMarker}`);
  const end = endMarker ? appJs.indexOf(endMarker, start) : appJs.length;
  if (end === -1) throw new Error(`Could not find ${endMarker}`);
  return appJs.slice(start, end).trim();
}

const sandbox = {
  console,
  Promise,
  cleanRunnerText: (value) => String(value || '').replace(/^\d+\.\s*/, '').trim(),
  normalizeRunnerName: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  computeRaceEta: () => ({ eta: 'in 8m' }),
  trackedGroupMeta: () => ({ isMulti: false, groupLabel: 'Multi' }),
  escapeAttr: (value) => String(value || '').replace(/'/g, '&#39;'),
  escapeHtml: (value) => String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};
vm.createContext(sandbox);
vm.runInContext([
  extractBetween('function computeTrackRunnerPayload(', 'function trackedGroupMeta('),
  extractBetween('function nextBestCandidates(', 'function renderWorkspaceSignalPanels('),
].join('\n\n'), sandbox);

const race = {
  meeting: 'Pukekohe',
  race_number: '4',
  runners: [
    { name: '1. Alpha', odds: 3.4 },
    { name: '2. Bravo', fixed_win: 7.2 },
  ],
};

const watchButtonsHtml = sandbox.buildTrackRunnerButtonsHtml(race, { name: '1. Alpha' }, null);
assert(watchButtonsHtml.includes("data-track-bet-type='Win'"));
assert(watchButtonsHtml.includes("data-track-bet-type='Watch'"));
assert(watchButtonsHtml.includes('>Watch<'));

const payloads = JSON.parse(JSON.stringify(sandbox.buildRaceTrackingPayloads(race, {
  betType: 'Watch',
  source: 'web-watch-race',
  note: 'Watch race from analysis',
})));

assert.deepStrictEqual(payloads, [
  {
    meeting: 'Pukekohe',
    race: '4',
    selection: 'Alpha',
    betType: 'Watch',
    odds: 3.4,
    entryOdds: 3.4,
    stake: null,
    jumpsIn: 'in 8m',
    note: 'Watch race from analysis',
    source: 'web-watch-race',
  },
  {
    meeting: 'Pukekohe',
    race: '4',
    selection: 'Bravo',
    betType: 'Watch',
    odds: 7.2,
    entryOdds: 7.2,
    stake: null,
    jumpsIn: 'in 8m',
    note: 'Watch race from analysis',
    source: 'web-watch-race',
  }
]);

const sameRunner = sandbox.nextBestCandidates({
  recommendedName: 'Alpha',
  recommendedKey: 'alpha',
  oddsRunner: { norm: 'alpha', runner: { name: 'Alpha' }, odds: 4.8 }
});
assert.strictEqual(sameRunner.oddsRunner, null);
assert.strictEqual(sameRunner.oddsRunnerKey, '');

const distinctRunner = sandbox.nextBestCandidates({
  recommendedName: 'Alpha',
  recommendedKey: 'alpha',
  oddsRunner: { norm: 'bravo', runner: { name: 'Bravo' }, odds: 8.5 }
});
assert.strictEqual(distinctRunner.oddsRunner.runner.name, 'Bravo');
assert.strictEqual(distinctRunner.oddsRunnerKey, 'bravo');

console.log('frontend_workspace_actions.test.js: ok');
