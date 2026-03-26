#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18083;
const BASE = `http://127.0.0.1:${PORT}`;
let defaultAuth = 'betman:change-me-now';
try {
  const authFile = path.join(__dirname, '..', 'memory', 'betman-auth.json');
  const cfg = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  if (cfg?.username && cfg?.password) defaultAuth = `${cfg.username}:${cfg.password}`;
} catch {}
const AUTH = Buffer.from(defaultAuth).toString('base64');

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForServer(timeoutMs = 10000){
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/ai-models`, { headers: { 'Authorization': `Basic ${AUTH}` } });
      if (res.ok || res.status === 401 || res.status === 403) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server did not become ready');
}

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

(async function main(){
  const env = {
    ...process.env,
    PORT: String(PORT),
    BETMAN_FAKE_AI: 'true',
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_OLLAMA_BASE_URL: 'http://office.waihekewater.com:11434',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-fake'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'ignore'
  });

  try {
    await waitForServer();

    const okOllama = await postAsk({ question: 'Ping test: respond with OK.', provider: 'ollama', model: 'deepseek-r1:8b' });
    assert.strictEqual(okOllama.status, 200);
    assert.strictEqual(okOllama.out.ok, true);
    assert.strictEqual(okOllama.out.modelUsed, 'deepseek-r1:8b');
    assert.strictEqual(okOllama.out.modelAdjusted, false);

    const okOpenAI = await postAsk({ question: 'Ping test: respond with OK.', provider: 'openai', model: 'gpt-4o-mini' });
    assert.strictEqual(okOpenAI.status, 200);
    assert.strictEqual(okOpenAI.out.ok, true);
    assert.strictEqual(okOpenAI.out.modelUsed, 'gpt-4o-mini');
    assert.strictEqual(okOpenAI.out.modelAdjusted, false);

    const blocked = await postAsk({ question: 'Ping test: respond with OK.', provider: 'openai', model: 'not-a-real-openai-model' });
    assert.strictEqual(blocked.status, 200);
    assert.strictEqual(blocked.out.mode, 'model_error');
    assert.strictEqual(blocked.out.fallbackReason, 'openai_model_not_allowed');
    assert.strictEqual(blocked.out.modelUsed, null);

    console.log('ai_model_authority tests passed');
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
