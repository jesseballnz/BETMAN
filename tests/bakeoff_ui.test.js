#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18084;
const BASE = `http://127.0.0.1:${PORT}`;
let defaultAuth = 'betman:change-me-now';
try {
  const authFile = path.join(__dirname, '..', 'memory', 'betman-auth.json');
  const cfg = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  if (cfg?.username && cfg?.password) defaultAuth = `${cfg.username}:${cfg.password}`;
} catch {}
const AUTH = Buffer.from(defaultAuth).toString('base64');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const BAKEOFF_RESULTS_DIR = path.join(__dirname, '..', 'bakeoff', 'results');

async function postAsk(payload){
  const res = await fetch(`${BASE}/api/ask-selection`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${AUTH}`
    },
    body: JSON.stringify(payload)
  });
  const out = await res.json();
  return { status: res.status, out };
}

async function getBakeoffLatest(){
  const res = await fetch(`${BASE}/api/model-bakeoff/latest`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${AUTH}`
    }
  });
  const out = await res.json();
  return { status: res.status, out };
}

function writeFakeBakeoffRun(){
  fs.mkdirSync(BAKEOFF_RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `leaderboard-${stamp}.json`;
  const payload = {
    generatedAt: new Date().toISOString(),
    runs: 2,
    prompts: ['race-win-core', 'risk-controls'],
    models: ['deepseek-r1:8b', 'gpt-4o-mini'],
    leaderboard: [
      {
        model: 'deepseek-r1:8b',
        contextTokens: 8192,
        successRate: 0.75,
        qualityAvg: 0.68,
        latencyP50Ms: 1200,
        latencyP95Ms: 2100,
        fallbackRate: 0.05
      },
      {
        model: 'gpt-4o-mini',
        contextTokens: 128000,
        successRate: 0.9,
        qualityAvg: 0.82,
        latencyP50Ms: 900,
        latencyP95Ms: 1400,
        fallbackRate: 0.02
      }
    ]
  };
  fs.writeFileSync(path.join(BAKEOFF_RESULTS_DIR, fileName), JSON.stringify(payload, null, 2));
  return { fileName, payload };
}

(async function main(){
  const env = {
    ...process.env,
    PORT: String(PORT),
    BETMAN_FAKE_AI: 'true',
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_CHAT_MODEL: '',
    BETMAN_OPENAI_BUTTON_ENABLED: 'true',
    BETMAN_OPENAI_COMPLIMENTARY: 'true',
    BETMAN_OLLAMA_BASE_URL: process.env.BETMAN_OLLAMA_BASE_URL || 'http://office.waihekewater.com:11434',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-fake'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], { env, stdio: 'ignore' });

  try {
    await sleep(1800);
    const basePayload = {
      source: 'race-analysis',
      question: 'Bakeoff UI harness – verify race-analysis path uses local context',
      selectionCount: 0,
      selections: [],
      uiContext: { day: '2026-03-13', country: 'NZ', meeting: 'Avondale' },
      raceContext: { meeting: 'Avondale', raceNumber: '4', raceName: 'UI Harness Check' }
    };

    const CASES = [
      { name: 'ollama_deepseek', provider: 'ollama', model: 'deepseek-r1:8b' },
      { name: 'openai_gpt4o', provider: 'openai', model: 'gpt-4o-mini' }
    ];

    for (const testCase of CASES) {
      const payload = { ...basePayload, provider: testCase.provider, model: testCase.model };
      const res = await postAsk(payload);
      assert.strictEqual(res.status, 200, `${testCase.name} status`);
      assert.strictEqual(res.out.ok, true, `${testCase.name} ok flag`);
      assert.notStrictEqual(res.out.mode, 'web_required', `${testCase.name} web fallback`);
      assert.strictEqual(res.out.modelUsed, testCase.model, `${testCase.name} modelUsed`);
      assert.ok(typeof res.out.answer === 'string' && res.out.answer.trim().length > 0, `${testCase.name} answer present`);
    }

    const { fileName, payload } = writeFakeBakeoffRun();
    const latest = await getBakeoffLatest();
    assert.strictEqual(latest.status, 200, 'bakeoff latest status');
    assert.strictEqual(latest.out.ok, true, 'bakeoff latest ok');
    assert.strictEqual(latest.out.file, fileName, 'bakeoff latest file');
    assert.ok(Array.isArray(latest.out.leaderboard) && latest.out.leaderboard.length === payload.leaderboard.length, 'bakeoff leaderboard length');
    assert.strictEqual(latest.out.leaderboard[0].successRate, payload.leaderboard[0].successRate, 'bakeoff success rate passthrough');
    assert.strictEqual(latest.out.leaderboard[0].qualityAvg, payload.leaderboard[0].qualityAvg, 'bakeoff quality passthrough');
    assert.strictEqual(latest.out.leaderboard[0].latencyP50Ms, payload.leaderboard[0].latencyP50Ms, 'bakeoff latency passthrough');

    console.log('bakeoff_ui tests passed');
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
