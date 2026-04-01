const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

assert(appJs.includes('function pulseFocusedMeetingFromTargeting(targeting = {})'), 'missing focused-meeting helper for Pulse targeting');
assert(appJs.includes('const meetingCards = buildPulseMeetingCards(candidateRaces, seedMeetings);'), 'Pulse target options should merge seeded meetings with live candidate races');
assert(appJs.includes('candidateMeetings = candidateMeetings.concat(options?.meetings || []);'), 'Pulse meeting filter should hydrate from target options, not only live alert rows');
assert(appJs.includes("const preferred = meetings.includes(prev)"), 'Pulse meeting filter should preserve valid selection before falling back');
assert(appJs.includes('return (lastRacesSnapshot || []).slice();'), 'unfiltered races loader should fall back to cached snapshot');
assert(appJs.includes("const fallbackPaths = [`./data/races-${dateStr}.json`, './data/races.json'];"), 'unfiltered races loader should fall back to static race files');

console.log('pulse_meeting_focus test passed');
