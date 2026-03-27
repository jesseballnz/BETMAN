#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function normalizeRunnerName(value){
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(aus|nz|ire|gb|usa|fr|jpn|ger|ity)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function normalizeTrackBucket(track){
  const raw = String(track || '').toLowerCase().trim();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('heavy')) return 'HEAVY';
  if (raw.includes('soft') || raw.includes('slow')) return 'SOFT';
  if (raw.includes('firm')) return 'FIRM';
  if (raw.includes('good')) return 'GOOD';
  return 'UNKNOWN';
}
function loadBloodlineLibrary(){
  const candidates = [
    path.join(__dirname, '..', 'data', 'pedigree', 'bloodlines.v1.json'),
    path.join(process.cwd(), 'data', 'pedigree', 'bloodlines.v1.json')
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  return { bloodlines: {}, femaleFamilies: {}, crosses: {} };
}
const LIBRARY = loadBloodlineLibrary();

function inferRaceArchetype(race){
  const country = String(race?.country || race?.jurisdiction || 'AUS').toUpperCase();
  const distance = Number(race?.distance || 0);
  const desc = String(race?.description || '').toLowerCase();
  const track = normalizeTrackBucket(race?.track_condition || '');
  const isG1 = /group 1|g1|golden slipper/.test(desc);
  const is2yo = /2yo|two-year|juvenile|slipper/.test(desc);
  if (is2yo && distance <= 1400 && isG1) return `${country}:2YO_SPRINT_G1`;
  if (is2yo && distance <= 1400) return `${country}:2YO_SPRINT`;
  if (track === 'HEAVY' || track === 'SOFT') {
    if (distance >= 1800) return `${country}:WET_STAYING`;
    if (distance >= 1400) return `${country}:WET_MIDDLE_DISTANCE`;
    return `${country}:WET_SPRINT`;
  }
  if (distance >= 1800) return `${country}:OPEN_STAYING`;
  if (distance > 1400) return `${country}:OPEN_MILE`;
  return `${country}:OPEN_SPRINT`;
}

function inferRacePedigreeDemand(race){
  const distance = Number(race?.distance || 0);
  const desc = String(race?.description || '').toLowerCase();
  const track = normalizeTrackBucket(race?.track_condition || '');
  const archetype = inferRaceArchetype(race);
  return {
    archetype,
    juvenile: /slipper|2yo|two-year|juvenile/.test(desc) ? 1.25 : (distance > 0 && distance <= 1200 ? 1.0 : 0.45),
    sprint: distance > 0 && distance <= 1400 ? 1.0 : 0.35,
    staying: distance >= 1800 ? 1.0 : 0.1,
    slipper: /golden slipper/.test(desc) ? 1.35 : (/slipper/.test(desc) ? 1.15 : 0),
    wet: track === 'HEAVY' ? 1.0 : (track === 'SOFT' ? 0.65 : 0.15),
    elite: /group 1|g1|group 2|g2|listed|classic|slipper/.test(desc) ? 0.8 : 0.35,
    precocity: /slipper|2yo|two-year|juvenile/.test(desc) ? 1.15 : 0.3
  };
}

function bloodlineEntry(name){
  const key = normalizeRunnerName(name || '');
  return key ? (LIBRARY.bloodlines?.[key] || null) : null;
}
function femaleFamilyEntry(name){
  const key = normalizeRunnerName(name || '');
  return key ? (LIBRARY.femaleFamilies?.[key] || null) : null;
}
function pedigreeComponentScoreFromTraits(traits, demand){
  if (!traits) return { score: 0, confidence: 0, known: false };
  const score =
    (traits.juvenile || 0) * (demand.juvenile || 0) +
    (traits.sprint || 0) * (demand.sprint || 0) +
    (traits.staying || 0) * (demand.staying || 0) +
    (traits.slipper || 0) * (demand.slipper || 0) +
    (traits.wet || 0) * (demand.wet || 0) +
    (traits.elite || 0) * (demand.elite || 0) +
    (traits.precocity || 0) * (demand.precocity || 0);
  return { score, confidence: Math.min(0.95, 0.58 + Object.keys(traits).length * 0.04), known: true };
}
function pedigreeComponentScore(name, demand){
  const entry = bloodlineEntry(name);
  if (!entry) return { score: 0, confidence: 0, known: false, prior: 1 };
  const base = pedigreeComponentScoreFromTraits(entry.traits, demand);
  const prior = Number(entry.priors?.[demand.archetype] || 1);
  return { score: base.score * prior, confidence: base.confidence, known: true, prior };
}
function femaleFamilyScore(name, demand){
  const entry = femaleFamilyEntry(name);
  if (!entry) return { score: 0, confidence: 0, known: false };
  return pedigreeComponentScoreFromTraits(entry.traits, demand);
}
function crossScore(sireName, damSireName, demand){
  const sire = normalizeRunnerName(sireName);
  const damSire = normalizeRunnerName(damSireName);
  const key = `${sire}|${damSire}`;
  const entry = LIBRARY.crosses?.[key];
  if (!entry) return { score: 0, confidence: 0, known: false };
  const contextFit = Array.isArray(entry.contexts) && entry.contexts.includes(demand.archetype) ? 1 : 0.75;
  return { score: (Number(entry.boost || 1) - 1) * 20 * contextFit, confidence: 0.78, known: true };
}
function runnerPedigreeSignal(runner, race){
  const demand = inferRacePedigreeDemand(race);
  const sire = pedigreeComponentScore(runner?.sire, demand);
  const damSire = pedigreeComponentScore(runner?.dam_sire || runner?.damSire, demand);
  const dam = femaleFamilyScore(runner?.dam, demand);
  const cross = crossScore(runner?.sire, runner?.dam_sire || runner?.damSire, demand);
  const total = (sire.score * 0.42) + (dam.score * 0.16) + (damSire.score * 0.24) + (cross.score * 0.18);
  const weightedConfidence =
    (sire.confidence * 0.42) +
    (dam.confidence * 0.16) +
    (damSire.confidence * 0.24) +
    (cross.confidence * 0.18);
  const primaryConfidence = Math.max(
    sire.known ? sire.confidence * 0.82 : 0,
    damSire.known ? damSire.confidence * 0.72 : 0,
    cross.known ? cross.confidence * 0.68 : 0
  );
  const confidence = Math.max(0.15, Math.min(0.97, Math.max(weightedConfidence, primaryConfidence)));
  return {
    score: total,
    confidence,
    archetype: demand.archetype,
    summary: `Pedigree ${total.toFixed(1)} | ${demand.archetype} | sire ${runner?.sire || 'n/a'} | dam ${runner?.dam || 'n/a'} | dam sire ${runner?.dam_sire || runner?.damSire || 'n/a'}`,
    parts: { sire, dam, damSire, cross }
  };
}
function computeRacePedigreeAdvantageMap(race, runners){
  const entries = (runners || []).map(r => ({ key: normalizeRunnerName(r?.name || r?.runner_name || ''), signal: runnerPedigreeSignal(r, race) })).filter(x => x.key);
  const scores = entries.map(x => x.signal.score).filter(Number.isFinite);
  const avg = scores.length ? scores.reduce((a,b)=>a+b,0) / scores.length : 0;
  const top = scores.length ? Math.max(...scores) : 0;
  const qualifiedKeys = new Set(entries.filter(x => {
    const clearFieldEdge = (x.signal.score - avg) >= 6 && (top - x.signal.score) <= 3;
    const eliteCompactField = top >= 34 && (top - x.signal.score) <= 1.25 && x.signal.score >= (avg + 2.5);
    return x.signal.score >= 24 && (x.signal.confidence * 100) >= 55 && (clearFieldEdge || eliteCompactField);
  }).map(x => x.key));
  return new Map(entries.map(x => [x.key, { ...x.signal, relativeEdge: x.signal.score - avg, qualifies: qualifiedKeys.has(x.key), topScore: top, averageScore: avg }]));
}

// Track condition confirmation thresholds
const TRACK_CONFIRM_MIN_STARTS = 3;
const TRACK_CONFIRM_STRONG_WIN_RATE = 0.25;
const TRACK_CONFIRM_STRONG_PLACE_RATE = 0.5;
const TRACK_CONFIRM_POOR_PLACE_RATE = 0.15;
const TRACK_CONFIRM_BOOST = 1.15;
const TRACK_CONFIRM_DISCOUNT = 0.7;

// Pedigree probability adjustment limits
const PEDIGREE_ADJ_CAP = 0.02;
const PEDIGREE_ADJ_SCALE = 0.02;
const PEDIGREE_MIN_CONFIDENCE = 0.50;

function trackConditionConfirmation(runner, signal) {
  if (!runner?.stats || !signal) return 1;
  const arch = String(signal.archetype || '');
  const isWet = arch.includes('WET');
  const conditionStats = isWet
    ? (runner.stats.heavy || runner.stats.soft)
    : (runner.stats.good || runner.stats.firm);
  if (!conditionStats) return 1;
  const starts = Number(conditionStats.number_of_starts || 0);
  if (starts < TRACK_CONFIRM_MIN_STARTS) return 1;
  const wins = Number(conditionStats.number_of_wins || 0);
  const placings = Number(conditionStats.number_of_placings || 0);
  const placeRate = placings / starts;
  const winRate = wins / starts;
  if (winRate >= TRACK_CONFIRM_STRONG_WIN_RATE || placeRate >= TRACK_CONFIRM_STRONG_PLACE_RATE) return TRACK_CONFIRM_BOOST;
  if (placeRate < TRACK_CONFIRM_POOR_PLACE_RATE) return TRACK_CONFIRM_DISCOUNT;
  return 1;
}

function pedigreeAdjFactor(runner, pedigreeMap) {
  if (!pedigreeMap) return 0;
  const key = normalizeRunnerName(runner?.runner_name || runner?.name || '');
  if (!key) return 0;
  const signal = pedigreeMap.get(key);
  if (!signal || !Number.isFinite(signal.score)) return 0;
  const relEdge = Number.isFinite(signal.relativeEdge) ? signal.relativeEdge : 0;
  const conf = Number.isFinite(signal.confidence) ? signal.confidence : 0;
  if (relEdge <= 0 || conf < PEDIGREE_MIN_CONFIDENCE) return 0;
  const trackConfirm = trackConditionConfirmation(runner, signal);
  const scaledEdge = Math.min(relEdge / 10, 1);
  return Math.min(PEDIGREE_ADJ_CAP, scaledEdge * conf * PEDIGREE_ADJ_SCALE * trackConfirm);
}

module.exports = {
  normalizeTrackBucket,
  inferRaceArchetype,
  inferRacePedigreeDemand,
  runnerPedigreeSignal,
  computeRacePedigreeAdvantageMap,
  pedigreeAdjFactor,
  trackConditionConfirmation,
  loadBloodlineLibrary
};
