'use strict';

function normalizePulseCountry(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'HKG') return 'HK';
  return upper;
}

function normalizePulseMeetingName(value) {
  return String(value || '').trim();
}

function normalizePulseRaceTarget(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const meeting = normalizePulseMeetingName(value.meeting);
    const race = String(value.race || value.race_number || value.raceNumber || '').trim().replace(/^R/i, '');
    if (!meeting || !race) return null;
    return `${meeting}::${race}`;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s*\|\s*/g, '::').replace(/\s*[—-]\s*R?/gi, '::');
  const parts = normalized.split('::').map((part) => String(part || '').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const race = String(parts.pop() || '').replace(/^R/i, '');
  const meeting = parts.join('::').trim();
  if (!meeting || !race) return null;
  return `${meeting}::${race}`;
}

function normalizePulseTargetList(values, normalizeFn) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeFn(value))
    .filter(Boolean)
    .filter((value, idx, arr) => arr.indexOf(value) === idx);
}

function normalizePulseTargeting(raw = {}) {
  const mode = String(raw?.mode || 'all').trim().toLowerCase();
  const allowedMode = ['all', 'countries', 'meetings', 'races', 'mixed'].includes(mode) ? mode : 'all';
  return {
    mode: allowedMode,
    countries: normalizePulseTargetList(raw?.countries, normalizePulseCountry),
    meetings: normalizePulseTargetList(raw?.meetings, normalizePulseMeetingName),
    races: normalizePulseTargetList(raw?.races, normalizePulseRaceTarget),
  };
}

function pulseRaceKey(row) {
  const meeting = normalizePulseMeetingName(row?.meeting);
  const race = String(row?.race_number || row?.race || row?.raceNumber || '').trim().replace(/^R/i, '');
  if (!meeting || !race) return null;
  return `${meeting}::${race}`;
}

function pulseRaceAdvertisedStartMs(row) {
  const advertised = row?.advertised_start;
  if (typeof advertised === 'number' && Number.isFinite(advertised)) {
    return advertised > 1e12 ? advertised : advertised * 1000;
  }
  if (typeof advertised === 'string' && advertised.trim()) {
    const asNumber = Number(advertised);
    if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
    const parsed = Date.parse(advertised);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function isPulseRaceFinished(row) {
  const statusBits = [
    row?.race_status,
    row?.status,
    row?.resultStatus,
    row?.state,
    row?.raceState,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (statusBits.some((value) => ['closed', 'final', 'finalized', 'resulted', 'settled', 'complete', 'completed', 'abandoned'].includes(value))) {
    return true;
  }
  if (row?.hasResult === true || row?.resulted === true || row?.isResulted === true || row?.isFinished === true || row?.raceSettled === true) {
    return true;
  }
  if (Array.isArray(row?.results) && row.results.length) return true;
  if (row?.result && typeof row.result === 'object' && Object.keys(row.result || {}).length) return true;
  return false;
}

function isPulseRacePast(row, nowMs = Date.now()) {
  if (isPulseRaceFinished(row)) return true;
  const startMs = pulseRaceAdvertisedStartMs(row);
  return Number.isFinite(startMs) ? startMs < nowMs : false;
}

function isPulseRaceTargetable(row, nowMs = Date.now()) {
  return !isPulseRacePast(row, nowMs);
}

function buildPulseRaceCatalog(rows = [], nowMs = Date.now()) {
  const byRace = new Map();
  const futureRaceKeysByMeeting = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = pulseRaceKey(row);
    if (!key) return;
    byRace.set(key, row);
    if (!isPulseRaceTargetable(row, nowMs)) return;
    const meeting = normalizePulseMeetingName(String(key).split('::')[0] || '');
    if (!futureRaceKeysByMeeting.has(meeting)) futureRaceKeysByMeeting.set(meeting, []);
    futureRaceKeysByMeeting.get(meeting).push(key);
  });
  return { byRace, futureRaceKeysByMeeting };
}

function prunePulseTargetingAgainstRaces(targeting = {}, rows = [], nowMs = Date.now()) {
  const normalized = normalizePulseTargeting(targeting || {});
  const catalog = buildPulseRaceCatalog(rows, nowMs);
  const prunedRaces = normalized.races.filter((key) => {
    const raceRow = catalog.byRace.get(key);
    if (!raceRow) return true;
    return isPulseRaceTargetable(raceRow, nowMs);
  });
  return {
    ...normalized,
    races: prunedRaces,
  };
}

function buildEffectivePulseScope(targeting = {}, rows = [], nowMs = Date.now()) {
  const normalized = prunePulseTargetingAgainstRaces(targeting, rows, nowMs);
  const catalog = buildPulseRaceCatalog(rows, nowMs);
  const meetingSet = new Set(normalized.meetings);
  const extraRaces = normalized.races.filter((key) => !meetingSet.has(normalizePulseMeetingName(String(key).split('::')[0] || '')));
  const effectiveRaceSet = new Set(extraRaces);
  normalized.meetings.forEach((meeting) => {
    (catalog.futureRaceKeysByMeeting.get(meeting) || []).forEach((key) => effectiveRaceSet.add(key));
  });
  return {
    targeting: normalized,
    extraRaces,
    effectiveRaceSet,
    meetingSet,
  };
}

module.exports = {
  normalizePulseCountry,
  normalizePulseMeetingName,
  normalizePulseRaceTarget,
  normalizePulseTargetList,
  normalizePulseTargeting,
  pulseRaceKey,
  pulseRaceAdvertisedStartMs,
  isPulseRaceFinished,
  isPulseRacePast,
  isPulseRaceTargetable,
  buildPulseRaceCatalog,
  prunePulseTargetingAgainstRaces,
  buildEffectivePulseScope,
};
