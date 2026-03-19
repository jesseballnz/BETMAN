#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { enforceRaceAnalysisAnswerFormat } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

const TENANT_ID = 'ai_analyse_test';
const tenantDir = path.join(ROOT, 'memory', 'tenants', TENANT_ID, 'frontend-data');
fs.mkdirSync(tenantDir, { recursive: true });

const statusFixture = {
  updatedAt: '2026-03-13T00:15:00.000Z',
  stakePerRace: 4,
  exoticStakePerRace: 1,
  earlyWindowMin: 180,
  aiWindowMin: 15,
  suggestedBets: [
    { meeting: 'Pukekohe', race: '6', selection: 'Astarte', type: 'Win', aiWinProb: 34.5, stake: 4.2, reason: 'p=34.5% @ 3.40' },
    { meeting: 'Pukekohe', race: '6', selection: 'Night Raider', type: 'Win', aiWinProb: 21.0, stake: 3.0, reason: 'p=21.0% @ 3.20' },
    { meeting: 'Pukekohe', race: '6', selection: 'Retro', type: 'Top3', stake: 0.8, reason: 'Top-3 profile from adjusted win probabilities' }
  ],
  marketMovers: [
    { meeting: 'Pukekohe', race: '6', runner: 'Astarte', pctMove: -6.5, pctSource: 'TAB', fromOdds: 3.8, toOdds: 3.4 },
    { meeting: 'Pukekohe', race: '6', runner: 'Night Raider', pctMove: 4.3, pctSource: 'TAB', fromOdds: 3.0, toOdds: 3.2 }
  ],
  interestingRunners: []
};

const racesFixture = {
  races: [
    {
      key: 'NZ:Pukekohe:R6',
      meeting: 'Pukekohe',
      race_number: '6',
      description: 'Karaka Classic',
      track_condition: 'Soft 6',
      weather: 'Overcast',
      rail_position: 'True',
      distance: 2100,
      runners: [
        { runner_number: 1, name: 'Astarte', odds: 3.40, barrier: 2, jockey: 'Masa Hashizume', trainer: 'R Patterson', weight: '55kg', speedmap: 'Leader', last_twenty_starts: 'x1123' },
        { runner_number: 2, name: 'Night Raider', odds: 3.20, barrier: 5, jockey: 'Craig Zackey', trainer: 'S Marsh', weight: '56.5kg', speedmap: 'On pace', last_twenty_starts: '21x35' },
        { runner_number: 3, name: 'Retro', odds: 8.50, barrier: 7, jockey: 'Opie Bosson', trainer: 'M Walker', weight: '55kg', speedmap: 'Midfield', last_twenty_starts: '4x563' }
      ]
    }
  ]
};

fs.writeFileSync(path.join(tenantDir, 'status.json'), JSON.stringify(statusFixture, null, 2));
fs.writeFileSync(path.join(tenantDir, 'races.json'), JSON.stringify(racesFixture, null, 2));

const clientContext = {
  source: 'race-analysis',
  raceContext: { meeting: 'Pukekohe', raceNumber: '6', raceName: 'Karaka Classic' }
};

const formatted = enforceRaceAnalysisAnswerFormat('Base AI text without structure.', clientContext, TENANT_ID);

function expect(pattern, message){
  if (!pattern.test(formatted)) {
    console.error(formatted);
    throw new Error(message || `missing pattern ${pattern}`);
  }
}

expect(/🏇 Pukekohe – Race 6: Karaka Classic/, 'header missing race slug');
expect(/🔎 Speed Map Projection\n- Leaders: Astarte/, 'speed map should list leaders');
expect(/🧬 Horse Profiles \(Key Contenders\)/, 'horse profiles section missing');
expect(/\| Astarte \| 3\.40 \| 29\.4% \| 34\.5% \| \+5\.1 pts \|/, 'odds vs model table missing overlay row');
expect(/🏆 Simulation Results \(Win%, Top 3%\)\n- Astarte — Win 34\.5% \| Top 3 71\.8%/, 'simulation summary missing top row');
expect(/💰 Value Analysis\n- Overlays: Astarte: model 34\.5% vs implied 29\.4% \(edge \+5\.1 pts\)/, 'overlay line missing');
expect(/- Underlays: Night Raider: model 21\.0% vs implied 31\.3% \(edge -10\.3 pts\)/, 'underlay line missing');
expect(/- Market movers: Astarte: firming 6\.5% over TAB \(3\.80→3\.40\) \| Night Raider: drifting 4\.3% over TAB \(3\.00→3\.20\)/, 'market movers missing');
expect(/🏁 Final Tips \+ Betting Strategy[\s\S]*- Main: Astarte/, 'main tip missing');
expect(/- Saver\/Exotics: TOP3: Retro/, 'exotic tip missing');
expect(/📈 Confidence %\n- 53% \(derived from top win profile \(34\.5%\)\)/, 'confidence not derived from top win profile');
expect(/🎙️ Punter Panel Debate[\s\S]*Panel sides with Astarte/, 'punter panel consensus missing');

console.log('ai_analyse tests passed');
