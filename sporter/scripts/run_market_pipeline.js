#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = process.cwd();

function runStep(label, scriptPath){
  const abs = path.join(ROOT, scriptPath);
  const res = spawnSync('node', [abs], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`Step ${label} failed`);
    process.exit(res.status || 1);
  }
}

const steps = [
  ['DraftKings poller', 'scripts/pollers/draftkings.js'],
  ['FanDuel poller', 'scripts/pollers/fanduel.js'],
  ['TAB Sports poller', 'scripts/pollers/tab_sports.js'],
  ['Model inputs', 'scripts/build_model_inputs.js'],
  ['Schedule builder', 'scripts/build_schedule.js'],
  ['Market snapshot', 'scripts/build_market_snapshot.js']
];

steps.forEach(([label, script]) => runStep(label, script));
console.log('Market pipeline completed.');
