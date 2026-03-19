#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'frontend', 'app.js'), 'utf8');
const startToken = 'function normalizeMeetingNameText';
const endToken = 'function handleMeetingSearchSubmit';
const startIdx = appJs.indexOf(startToken);
const handleIdx = appJs.indexOf(endToken);
if (startIdx === -1 || handleIdx === -1) {
  throw new Error('meeting search helpers not found in app.js');
}
let braceIdx = appJs.indexOf('{', handleIdx);
if (braceIdx === -1) throw new Error('malformed handleMeetingSearchSubmit definition');
let depth = 0;
let endIdx = -1;
for (let i = braceIdx; i < appJs.length; i++) {
  const ch = appJs[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }
}
if (endIdx === -1) throw new Error('could not locate end of handleMeetingSearchSubmit');
const block = appJs.slice(startIdx, endIdx);
const context = {
  console,
  $: () => null,
  loadAllRacesUnfiltered: async () => [],
  racesCache: [],
  lastRacesSnapshot: []
};
vm.createContext(context);
vm.runInContext(block, context);

const parse = context.parseMeetingSearchValue;
const parseClone = (value) => JSON.parse(JSON.stringify(parse(value)));
assert.deepStrictEqual(parseClone('Launceston R4'), { meeting: 'Launceston', race: '4' });
assert.deepStrictEqual(parseClone('launceston 07'), { meeting: 'launceston', race: '7' });
assert.deepStrictEqual(parseClone('Cranbourne'), { meeting: 'Cranbourne', race: null });

context.racesCache = [
  { meeting: 'Cranbourne Night', country: 'AUS' }
];
context.lastRacesSnapshot = [
  { meeting: 'Launceston', country: 'AUS' },
  { meeting: 'Matamata', country: 'NZ' }
];

async function run(){
  const hit1 = await context.resolveMeetingMeta('launceston');
  assert(hit1, 'expected Launceston match');
  assert.strictEqual(hit1.meeting, 'Launceston');
  const hit2 = await context.resolveMeetingMeta('cranbourne night');
  assert(hit2, 'expected Cranbourne Night match from racesCache');
  assert.strictEqual(hit2.meeting, 'Cranbourne Night');
  const miss = await context.resolveMeetingMeta('Nonexistent');
  assert.strictEqual(miss, null);
  console.log('meeting_search tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
