#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const INTERVAL = Number(process.env.SPORTER_POLL_INTERVAL_MS || 60000);
const STATE_PATH = path.join(ROOT, 'memory', 'poll_state.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeState(data) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
}

async function runPipeline() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/run_market_pipeline.js'], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`pipeline exited with ${code}`));
    });
  });
}

async function loop() {
  const state = {
    startedAt: new Date().toISOString(),
    intervalMs: INTERVAL,
    runs: 0,
    failures: 0,
    lastSuccess: null,
    lastError: null
  };
  writeState(state);

  while (true) {
    const started = Date.now();
    try {
      await runPipeline();
      state.runs += 1;
      state.lastSuccess = new Date().toISOString();
      state.lastError = null;
    } catch (err) {
      state.failures += 1;
      state.lastError = { message: err.message, at: new Date().toISOString() };
      console.error('Sportr poll loop error:', err.message);
    }
    writeState(state);
    const elapsed = Date.now() - started;
    const wait = Math.max(1000, INTERVAL - elapsed);
    await sleep(wait);
  }
}

loop().catch(err => {
  console.error('poll loop crashed', err);
  process.exit(1);
});
