#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'status.json'), 'utf8'));

const movers = status.marketMovers || [];
const suggested = status.suggestedBets || [];

assert(movers.length > 0, 'marketMovers should not be empty');
assert(suggested.length > 0, 'suggestedBets should not be empty');

const pukekoheMovers = movers.filter(r => String(r.meeting || '').trim().toLowerCase() === 'pukekohe');
assert(pukekoheMovers.length > 0, 'Pukekohe market movers should not be empty when Pukekohe races are active');

console.log('data_presence tests passed');
