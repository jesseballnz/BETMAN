#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'frontend_server.js'), 'utf8');

function extractConst(name) {
  const marker = `const ${name} =`;
  const start = serverJs.indexOf(marker);
  if (start === -1) throw new Error(`Could not find const ${name}`);
  const end = serverJs.indexOf(';', start);
  if (end === -1) throw new Error(`Could not parse const ${name}`);
  return serverJs.slice(start, end + 1);
}

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = serverJs.indexOf(marker);
  if (start === -1) throw new Error(`Could not find function ${name}`);
  let brace = serverJs.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < serverJs.length; i++) {
    const ch = serverJs[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Could not parse function ${name}`);
  return serverJs.slice(start, end);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  [
    extractConst('FINISHED_RACE_STATUSES'),
    extractFunction('normalizeMeetingName'),
    extractFunction('normalizeRaceValue'),
    extractFunction('normalizeRunnerName'),
    extractFunction('normalizeTrackedKey'),
    extractFunction('toPositiveOddsValue'),
    extractFunction('resolveTrackedCurrentOdds'),
    extractFunction('resolveTrackedRaceJumpMeta'),
    extractFunction('resolveTrackedRaceStatus'),
    extractFunction('enrichTrackedBetWithCurrentOdds'),
  ].join('\n\n'),
  sandbox
);

const raceKey = `${sandbox.normalizeMeetingName('Newcastle')}|${sandbox.normalizeRaceValue('R1')}`;
const trackedKey = sandbox.normalizeTrackedKey('Newcastle', 'R1', 'Cavalry');

const finishedRaceContext = {
  raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'FINAL' }]]),
  runnerMap: new Map(),
  moverMap: new Map([[trackedKey, { currentOdds: 6.8, source: 'market-movers' }]]),
  suggestedMap: new Map([[trackedKey, { currentOdds: 6.2, source: 'suggested-bets' }]]),
};

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    { meeting: 'Newcastle', race: 'R1', selection: 'Cavalry', entryOdds: 4.4, status: 'active' },
    finishedRaceContext,
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'settled',
    odds: 4.4,
    entryOdds: 4.4,
    currentOdds: 4.4,
    currentOddsSource: 'last known (entry)',
    jumpsIn: null,
    minsToJump: null,
    raceStartTime: null,
    raceStatus: 'FINAL',
  }
);

const liveRaceContext = {
  raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'OPEN', mins_to_jump: 8, start_time: '2099-01-01T00:08:00.000Z' }]]),
  runnerMap: new Map(),
  moverMap: new Map([[trackedKey, { currentOdds: 6.8, source: 'market-movers' }]]),
  suggestedMap: new Map([[trackedKey, { currentOdds: 6.2, source: 'suggested-bets' }]]),
};

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    { meeting: 'Newcastle', race: 'R1', selection: 'Cavalry', entryOdds: 4.4, status: 'active' },
    liveRaceContext,
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'active',
    odds: 4.4,
    entryOdds: 4.4,
    currentOdds: 6.8,
    currentOddsSource: 'market-movers',
    jumpsIn: 'in 8m',
    minsToJump: 8,
    raceStartTime: '2099-01-01T00:08:00.000Z',
    raceStatus: 'OPEN',
  }
);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    {
      meeting: 'Newcastle',
      race: 'R1',
      selection: 'Cavalry',
      status: 'active',
      currentOdds: 5.5,
      currentOddsSource: 'cached-live',
      entryOdds: null,
      odds: 4.4,
    },
    { raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'OPEN', mins_to_jump: 8, start_time: '2099-01-01T00:08:00.000Z' }]]), runnerMap: new Map(), moverMap: new Map(), suggestedMap: new Map() },
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'active',
    currentOdds: 5.5,
    currentOddsSource: 'cached-live',
    entryOdds: 4.4,
    odds: 4.4,
    jumpsIn: 'in 8m',
    minsToJump: 8,
    raceStartTime: '2099-01-01T00:08:00.000Z',
    raceStatus: 'OPEN',
  }
);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    { meeting: 'Newcastle', race: 'R1', selection: 'Cavalry', odds: 4.4, status: 'active' },
    { raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'OPEN', mins_to_jump: 8, start_time: '2099-01-01T00:08:00.000Z' }]]), runnerMap: new Map(), moverMap: new Map(), suggestedMap: new Map() },
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'active',
    odds: 4.4,
    entryOdds: 4.4,
    currentOdds: 4.4,
    currentOddsSource: 'entry',
    jumpsIn: 'in 8m',
    minsToJump: 8,
    raceStartTime: '2099-01-01T00:08:00.000Z',
    raceStatus: 'OPEN',
  }
);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    {
      meeting: 'Newcastle',
      race: 'R1',
      selection: 'Cavalry',
      status: 'active',
      currentOdds: 5.5,
      currentOddsSource: 'cached-live',
      entryOdds: 4.4,
    },
    {
      raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'OPEN', mins_to_jump: 8, start_time: '2099-01-01T00:08:00.000Z' }]]),
      runnerMap: new Map(),
      moverMap: new Map([[trackedKey, { currentOdds: 6.8, source: 'market-movers' }]]),
      suggestedMap: new Map(),
    },
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'active',
    currentOdds: 6.8,
    currentOddsSource: 'market-movers',
    entryOdds: 4.4,
    odds: 4.4,
    jumpsIn: 'in 8m',
    minsToJump: 8,
    raceStartTime: '2099-01-01T00:08:00.000Z',
    raceStatus: 'OPEN',
  }
);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.enrichTrackedBetWithCurrentOdds(
    { meeting: 'Newcastle', race: 'R1', selection: 'Cavalry', entryOdds: 4.4, status: 'active' },
    {
      raceMap: new Map([[raceKey, { meeting: 'Newcastle', race_number: '1', race_status: 'OPEN', mins_to_jump: -2, start_time: '2099-01-01T00:08:00.000Z' }]]),
      runnerMap: new Map(),
      moverMap: new Map([[trackedKey, { currentOdds: 6.8, raceStatus: 'FINAL', source: 'market-movers' }]]),
      suggestedMap: new Map(),
    },
  ))),
  {
    meeting: 'Newcastle',
    race: 'R1',
    selection: 'Cavalry',
    status: 'settled',
    odds: 4.4,
    entryOdds: 4.4,
    currentOdds: 4.4,
    currentOddsSource: 'last known (entry)',
    jumpsIn: 'Jumped',
    minsToJump: -2,
    raceStartTime: '2099-01-01T00:08:00.000Z',
    raceStatus: 'FINAL',
  }
);

console.log('frontend_tracked_bets.test.js: ok');
