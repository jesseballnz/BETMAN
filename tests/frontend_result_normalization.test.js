#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = appJs.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${name}`);
  let brace = appJs.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Could not parse ${name}`);
  return appJs.slice(start, end);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${extractFunction('canonicalTrackedResultLabel')}\n${extractFunction('normalizeSettledResultValue')}`, sandbox);

assert.strictEqual(sandbox.canonicalTrackedResultLabel('placed'), 'won');
assert.strictEqual(sandbox.canonicalTrackedResultLabel('place'), 'won');
assert.strictEqual(sandbox.normalizeSettledResultValue('won'), 'win');
assert.strictEqual(sandbox.normalizeSettledResultValue('lost'), 'loss');
assert.strictEqual(sandbox.normalizeSettledResultValue('placed'), 'ew_place');
assert.strictEqual(sandbox.normalizeSettledResultValue('place'), 'ew_place');
assert.strictEqual(sandbox.normalizeSettledResultValue('ew_place'), 'ew_place');

console.log('frontend_result_normalization.test.js: ok');
