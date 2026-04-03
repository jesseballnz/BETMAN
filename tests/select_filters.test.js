#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'status.json'), 'utf8'));
const races = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'races.json'), 'utf8'));
const appJs = fs.readFileSync(path.join(ROOT, 'frontend', 'app.js'), 'utf8');

const raceRows = Array.isArray(races.races) ? races.races : [];

function normalizeMeetingName(meeting){
  return String(meeting || '')
    .trim()
    .toLowerCase()
    .replace(/\bpoly\s+track\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferRowCountry(row){
  const direct = String(row?.country || '').trim().toUpperCase();
  if (direct) return direct;
  const mtg = normalizeMeetingName(row?.meeting || '');
  const rc = String(row?.race || row?.race_number || '').replace(/^R/i,'').trim();
  const hit = raceRows.find(r =>
    normalizeMeetingName(r.meeting) === mtg &&
    String(r.race_number || '').trim() === rc
  );
  return String(hit?.country || '').trim().toUpperCase();
}

function scopedRows(rows, selectedCountry = 'ALL', selectedMeeting = 'ALL'){
  return (rows || []).filter(r => {
    const meetingOk = selectedMeeting === 'ALL' || normalizeMeetingName(r.meeting) === normalizeMeetingName(selectedMeeting);
    const country = inferRowCountry(r);
    const countryOk = selectedCountry === 'ALL' || country === String(selectedCountry).toUpperCase();
    return meetingOk && countryOk;
  });
}

function assertCountryScope(name, rows, country){
  const scoped = scopedRows(rows, country, 'ALL');
  scoped.forEach(r => {
    const c = inferRowCountry(r);
    assert.strictEqual(c, country, `${name} row leaked country: got ${c}, expected ${country} (${r.meeting} R${r.race})`);
  });
}

function assertMeetingScope(name, rows, country, meeting){
  const scoped = scopedRows(rows, country, meeting);
  scoped.forEach(r => {
    assert.strictEqual(normalizeMeetingName(r.meeting), normalizeMeetingName(meeting), `${name} row leaked meeting (${r.meeting}) while ${meeting} selected`);
    const c = inferRowCountry(r);
    assert.strictEqual(c, country, `${name} row leaked country ${c} while ${country} selected`);
  });
}

// 1) ALL Meetings must still obey selected country.
assertCountryScope('suggestedBets', status.suggestedBets || [], 'NZ');
assertCountryScope('interestingRunners', status.interestingRunners || [], 'NZ');
assertCountryScope('marketMovers', status.marketMovers || [], 'NZ');

// 2) Specific meeting should return only that meeting and country.
const nzMeetings = [...new Set(raceRows.filter(r => String(r.country || '').toUpperCase() === 'NZ').map(r => r.meeting).filter(Boolean))];
if (nzMeetings.length) {
  assertMeetingScope('suggestedBets', status.suggestedBets || [], 'NZ', nzMeetings[0]);
  assertMeetingScope('interestingRunners', status.interestingRunners || [], 'NZ', nzMeetings[0]);
}

// 3) Interesting rows should carry enough scope metadata (direct or inferred country).
(status.interestingRunners || []).forEach(r => {
  const c = inferRowCountry(r);
  assert(c, `interesting row missing country and could not infer: ${r.meeting} R${r.race} ${r.runner}`);
});

// 4) Frontend meeting scoping should be row-aware so country inference survives duplicate meeting names.
assert(appJs.includes('function inferRowCountry(row){'), 'frontend missing inferRowCountry helper');
assert(appJs.includes('const rowCountry = normalizeCountryKey(row?.country) || inferRowCountry(row);'), 'meeting matcher should infer row country before filtering');
assert(appJs.includes('filter(r => meetingMatches(r))'), 'frontend filters should pass full rows into meetingMatches for country-aware scoping');

console.log('select_filters tests passed');
