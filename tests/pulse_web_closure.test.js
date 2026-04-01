const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');

assert(appJs.includes("if (!sel) return 'all';"), 'Pulse filter hydrators should return a stable default');
assert(appJs.includes('const [countryFilter, meetingFilter] = await Promise.all(['), 'Pulse shell should await both filter hydrators before reading selection state');
assert(appJs.includes("selectedMeetingLabel && meetings.includes(selectedMeetingLabel) ? selectedMeetingLabel : 'all'"), 'Pulse meeting filter should fall back to the locked selected meeting when valid');
assert(appJs.includes("const targetingCountries = normalizePulseTargeting(pulseConfigState?.targeting || {}).countries || [];"), 'Pulse country filter should include targeting countries, not only live alert rows');
assert(appJs.includes("<div><b>Pulse feed</b></div><div>${cfg?.enabled === false ? 'Disabled' : 'Enabled'}</div>"), 'Auth settings should expose overall Pulse enabled state');
assert(appJs.includes("${alertTypes[item.key] ? 'Enabled' : 'Disabled'}"), 'Pulse config should show enabled/disabled state per rule');

console.log('pulse_web_closure test passed');
