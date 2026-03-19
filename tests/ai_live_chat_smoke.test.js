#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
let defaultAuth = 'betman:change-me-now';
try {
  const authFile = path.join(__dirname, '..', 'memory', 'betman-auth.json');
  const cfg = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  if (cfg?.username && cfg?.password) defaultAuth = `${cfg.username}:${cfg.password}`;
} catch {}
const AUTH = Buffer.from(defaultAuth).toString('base64');

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

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

async function fetchModelCatalog(){
  try {
    const res = await fetch(`${BASE}/api/ai-models`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${AUTH}` }
    });
    const out = await res.json();
    if (res.ok && out && out.ok) return out;
    return { ollamaModels: [], openaiModels: [] };
  } catch (err) {
    console.warn('ai_live_chat_smoke: failed to load model catalog', err);
    return { ollamaModels: [], openaiModels: [] };
  }
}

function providerForModel(model){
  return String(model).toLowerCase().includes('gpt') ? 'openai' : 'ollama';
}

async function smokeModel(model){
  const res = await postAsk({
    question: `Live routing smoke matrix (${model})`,
    source: 'race-analysis',
    raceContext: { meeting: 'Pakenham', raceNumber: '5' },
    model
  });

  assert.strictEqual(res.status, 200, `${model} request failed`);
  assert.strictEqual(res.out.ok, true, `${model} response not ok`);
  const expectedProvider = providerForModel(model);
  assert.strictEqual(res.out.provider, expectedProvider, `${model} routed to wrong provider`);
  assert.strictEqual(res.out.modelRequested, model, `${model} should be echoed in modelRequested`);
  assert.strictEqual(res.out.modelUsed, model, `${model} should not be adjusted silently`);
}

(async function main(){
  const env = {
    ...process.env,
    PORT: String(PORT),
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_OLLAMA_BASE_URL: process.env.BETMAN_OLLAMA_BASE_URL || 'http://office.waihekewater.com:11434'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], { env, stdio: 'ignore' });

  try {
    // Wait for server to boot.
    await sleep(1800);

    const catalog = await fetchModelCatalog();
    const ollamaModels = Array.from(new Set(catalog.ollamaModels || [])).filter(Boolean);
    const openaiModels = Array.from(new Set(catalog.openaiModels || [])).filter(Boolean);

    const tested = [];

    for (const model of ollamaModels) {
      await smokeModel(model);
      tested.push(model);
    }

    for (const model of openaiModels) {
      await smokeModel(model);
      tested.push(model);
    }

    if (!tested.length) {
      console.log('ai_live_chat_smoke tests skipped — no AI models advertised.');
    } else {
      console.log(`ai_live_chat_smoke tests passed (${tested.join(', ')})`);
    }
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
