#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'status.json'), 'utf8'));
const races = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'races.json'), 'utf8'));

const movers = status.marketMovers || [];
const suggested = status.suggestedBets || [];
const activeRaces = races.races || [];

assert(Array.isArray(movers), 'marketMovers should be an array');
assert(Array.isArray(suggested), 'suggestedBets should be an array');
assert(Array.isArray(activeRaces), 'races should be an array');
if (activeRaces.length > 0) {
  assert(movers.length > 0, 'marketMovers should not be empty when active races exist');
}

const pukekoheActive = activeRaces.some(r => String(r.meeting || '').trim().toLowerCase() === 'pukekohe');
const pukekoheMovers = movers.filter(r => String(r.meeting || '').trim().toLowerCase() === 'pukekohe');
if (pukekoheActive) {
  assert(pukekoheMovers.length > 0, 'Pukekohe market movers should not be empty when Pukekohe races are active');
}

const winSuggested = suggested.filter(r => String(r.type || '').toLowerCase() === 'win');
if (suggested.length > 0) {
  assert(winSuggested.length >= 1, 'If suggested bets exist, at least one win suggestion should be present');
}

console.log('data_presence tests passed');
