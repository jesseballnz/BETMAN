#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'status.json'), 'utf8'));

const movers = status.marketMovers || [];
const suggested = status.suggestedBets || [];

// Structural checks – arrays must exist regardless of live data
assert(Array.isArray(status.marketMovers), 'marketMovers must be an array');
assert(Array.isArray(status.suggestedBets), 'suggestedBets must be an array');

// When data is populated, validate shape
if (movers.length > 0) {
  for (const m of movers) {
    assert(m.meeting || m.race, 'Each mover entry must have a meeting or race identifier');
  }
}

if (suggested.length > 0) {
  for (const s of suggested) {
    assert(s.meeting || s.race, 'Each suggested bet must have a meeting or race identifier');
  }
}

console.log(`data_presence tests passed (movers=${movers.length}, suggested=${suggested.length})`);
