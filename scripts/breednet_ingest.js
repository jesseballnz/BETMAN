#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'pedigree', 'breednet', 'sire_tables_2026-03-21.txt');
const LIB = path.join(ROOT, 'data', 'pedigree', 'bloodlines.v1.json');
const OUT = path.join(ROOT, 'memory', 'breednet-ingest-report.json');

function norm(s='') {
  return String(s).toLowerCase().replace(/\([^)]*\)/g,' ').replace(/[^a-z0-9']+/g,' ').trim();
}
function loadJson(file, fallback){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function writeJson(file, data){ fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

const sectionTraitMap = {
  'General Sires by Earnings': { elite: 2, sprint: 1, juvenile: 1 },
  'First Season Sires by Earnings': { juvenile: 2, precocity: 2 },
  'Second Season Sires': { juvenile: 1, precocity: 1, sprint: 1 },
  'Third Season Sires': { juvenile: 1, sprint: 1, elite: 1 },
  'Two Year Old Sires': { juvenile: 3, precocity: 3, slipper: 2 },
  'Three Year Old Sires': { sprint: 2, elite: 1, precocity: 1 },
  'Four Year Old Sires': { sprint: 1, elite: 2 },
  'Broodmare Sires': { elite: 2 },
  'Sires - 1200m and shorter': { sprint: 3, precocity: 1 },
  'Sires - 1200m to 1600m': { sprint: 2, elite: 1 },
  'Sires - 1600m to 2000m': { staying: 2, wet: 1, elite: 1 },
  'Sires - 2000m plus': { staying: 3, wet: 1, elite: 1 }
};

const sectionPriorMap = {
  'Two Year Old Sires': ['AUS:2YO_SPRINT','AUS:2YO_SPRINT_G1'],
  'First Season Sires by Earnings': ['AUS:2YO_SPRINT'],
  'Sires - 1200m and shorter': ['AUS:OPEN_SPRINT'],
  'Sires - 1200m to 1600m': ['AUS:OPEN_SPRINT','AUS:OPEN_MILE','NZ:OPEN_SPRINT'],
  'Sires - 1600m to 2000m': ['NZ:OPEN_MILE','NZ:WET_MIDDLE_DISTANCE'],
  'Sires - 2000m plus': ['NZ:WET_STAYING','NZ:OPEN_STAYING'],
  'Broodmare Sires': ['AUS:2YO_SPRINT_G1','AUS:OPEN_SPRINT','NZ:WET_STAYING']
};

function parseSections(text){
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const sections = {};
  let current = null;
  for (const line of lines) {
    if (sectionTraitMap[line]) { current = line; sections[current] = []; continue; }
    if (!current) continue;
    if (/^Click here for top 50$/i.test(line)) continue;
    const m = line.match(/^(.*?)\s+\d+\s+\d+/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || /^sire$/i.test(name)) continue;
    sections[current].push(name);
  }
  return sections;
}

function seedCommentary(name, sections){
  const out = [];
  if (sections.includes('Two Year Old Sires')) out.push('Ranks in Breednet 2YO sires, supporting juvenile speed and precocity.');
  if (sections.includes('Sires - 1200m and shorter')) out.push('Appears in top short-course sire tables, supporting sprint speed.');
  if (sections.includes('Sires - 1200m to 1600m')) out.push('Appears in 1200m-1600m tables, supporting sprint/mile versatility.');
  if (sections.includes('Sires - 1600m to 2000m')) out.push('Appears in middle-distance sire tables, supporting stamina beyond pure speed.');
  if (sections.includes('Sires - 2000m plus')) out.push('Appears in staying sire tables, supporting deeper stamina profiles.');
  if (sections.includes('Broodmare Sires')) out.push('Also appears as a leading broodmare sire, strengthening dam-side relevance.');
  return out.join(' ');
}

const text = fs.readFileSync(SRC, 'utf8');
const sections = parseSections(text);
const library = loadJson(LIB, { version:1, bloodlines:{}, femaleFamilies:{}, crosses:{} });
const touched = {};

for (const [section, names] of Object.entries(sections)) {
  names.forEach((name, idx) => {
    const key = norm(name);
    if (!key) return;
    const entry = library.bloodlines[key] || { sireLine: null, jurisdictions:['AUS'], traits:{}, priors:{}, commentary:{} };
    const rankBoost = Math.max(0.4, (11 - Math.min(idx + 1, 10)) / 10);
    const traitMap = sectionTraitMap[section] || {};
    Object.entries(traitMap).forEach(([trait, weight]) => {
      entry.traits[trait] = Number((Math.max(Number(entry.traits[trait] || 0), weight * 2 * rankBoost + Number(entry.traits[trait] || 0) * 0.35)).toFixed(2));
    });
    (sectionPriorMap[section] || []).forEach(priorKey => {
      const cur = Number(entry.priors[priorKey] || 1);
      entry.priors[priorKey] = Number(Math.max(cur, 1 + (0.02 * (11 - Math.min(idx + 1, 10)))).toFixed(2));
    });
    entry.commentary = entry.commentary || {};
    entry.commentary.breednet = seedCommentary(name, Object.entries(sections).filter(([,arr]) => arr.includes(name)).map(([s]) => s));
    entry.commentary.sources = Array.from(new Set([...(entry.commentary.sources || []), 'breednet:sire_tables_2026-03-21']));
    library.bloodlines[key] = entry;
    touched[key] = { name, section, rank: idx + 1 };
  });
}

library.updatedAt = new Date().toISOString();
library.notes = String(library.notes || '') + ' Breednet sire tables ingested 2026-03-21.';
writeJson(LIB, library);
writeJson(OUT, {
  generatedAt: new Date().toISOString(),
  source: SRC,
  sections: Object.fromEntries(Object.entries(sections).map(([k,v]) => [k, v.length])),
  touched: Object.keys(touched).length,
  sample: Object.values(touched).slice(0, 40)
});
console.log(JSON.stringify({ touched: Object.keys(touched).length, sections: Object.keys(sections).length }, null, 2));
