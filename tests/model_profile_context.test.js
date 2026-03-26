#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18082;
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
      const res = await fetch(`${BASE}/api/ai-models`, {
        method: 'GET',
        headers: { 'Authorization': `Basic ${AUTH}` }
      });
      if (res.ok || res.status === 401 || res.status === 403) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not become ready on ${BASE} within ${timeoutMs}ms`);
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
    BETMAN_CONTEXT_MAX_RACE_ANALYSIS_SMALL: '9100',
    BETMAN_CONTEXT_MAX_GENERAL_SMALL: '1900',
    BETMAN_CHAT_HISTORY_TURNS_SMALL: '5',
    BETMAN_CHAT_HISTORY_CHARS_SMALL: '950',
    BETMAN_CONTEXT_MAX_RACE_ANALYSIS: '15000',
    BETMAN_CONTEXT_MAX_GENERAL: '3200',
    BETMAN_CHAT_HISTORY_TURNS: '8',
    BETMAN_CHAT_HISTORY_CHARS: '1400',
    BETMAN_CHAT_MODEL: '',
    BETMAN_OLLAMA_BASE_URL: process.env.BETMAN_OLLAMA_BASE_URL || 'http://office.waihekewater.com:11434',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-fake'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], { env, stdio: 'ignore' });

  try {
    await waitForServer();

    const CASES = [
      {
        name: 'deepseek_race',
        payload: {
          question: 'Model audit deepseek race',
          source: 'race-analysis',
          raceContext: { meeting: 'Randwick', raceNumber: '5' },
          model: 'deepseek-r1:8b'
        },
        expect: { context: 9100, historyTurns: 5, historyChars: 950, model: 'deepseek-r1:8b' }
      },
      {
        name: 'deepseek_general',
        payload: {
          question: 'Model audit deepseek general',
          model: 'deepseek-r1:8b'
        },
        expect: { context: 1900, historyTurns: 5, historyChars: 950, model: 'deepseek-r1:8b' }
      },
      {
        name: 'llama_general',
        payload: {
          question: 'Model audit llama general',
          model: 'llama3.1:8b'
        },
        expect: { context: 1900, historyTurns: 5, historyChars: 950, model: 'llama3.1:8b' }
      },
      {
        name: 'gpt4o_race',
        payload: {
          question: 'Model audit gpt race',
          source: 'race-analysis',
          raceContext: { meeting: 'Flemington', raceNumber: '7' },
          provider: 'openai',
          model: 'gpt-4o-mini'
        },
        expect: { context: 15000, historyTurns: 8, historyChars: 1400, model: 'gpt-4o-mini' }
      },
      {
        name: 'gpt4o_general',
        payload: {
          question: 'Model audit gpt general',
          provider: 'openai',
          model: 'gpt-4o-mini'
        },
        expect: { context: 3200, historyTurns: 8, historyChars: 1400, model: 'gpt-4o-mini' }
      },
      {
        name: 'gpt52_general',
        payload: {
          question: 'Model audit gpt5 general',
          provider: 'openai',
          model: 'gpt-5.2'
        },
        expect: { context: 3200, historyTurns: 8, historyChars: 1400, model: 'gpt-5.2' }
      },
      {
        name: 'llama32_3b_race',
        payload: {
          question: 'Model audit llama3.2 race',
          source: 'race-analysis',
          raceContext: { meeting: 'Avondale', raceNumber: '2' },
          model: 'llama3.2:3b'
        },
        expect: { context: 9100, historyTurns: 5, historyChars: 950, model: 'llama3.2:3b' }
      },
      {
        name: 'llama32_3b_general',
        payload: {
          question: 'Model audit llama3.2 general',
          model: 'llama3.2:3b'
        },
        expect: { context: 1900, historyTurns: 5, historyChars: 950, model: 'llama3.2:3b' }
      }
    ];

    for (const testCase of CASES) {
      const res = await postAsk(testCase.payload);
      assert.strictEqual(res.status, 200, `${testCase.name} status`);
      assert.strictEqual(res.out.ok, true, `${testCase.name} ok flag`);
      assert.strictEqual(res.out.contextMaxLength, testCase.expect.context, `${testCase.name} contextMaxLength`);
      assert.strictEqual(res.out.historyTurnsUsed, testCase.expect.historyTurns, `${testCase.name} historyTurns`);
      assert.strictEqual(res.out.historyCharsUsed, testCase.expect.historyChars, `${testCase.name} historyChars`);
      assert.strictEqual(res.out.modelUsed, testCase.expect.model, `${testCase.name} modelUsed`);
      assert.strictEqual(!!res.out.modelAdjusted, false, `${testCase.name} modelAdjusted`);
    }

    console.log('model_profile_context tests passed');
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
