#!/usr/bin/env node
const assert = require('assert');
const http   = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { isSmallModel } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// --- Unit: isSmallModel ---
assert.strictEqual(isSmallModel('deepseek-r1:8b'), true, 'deepseek-r1:8b is small');
assert.strictEqual(isSmallModel('llama3.1:8b'), true, 'llama3.1:8b is small');
assert.strictEqual(isSmallModel('llama3.2:3b'), true, 'llama3.2:3b is small');
assert.strictEqual(isSmallModel('qwen2.5:1.5b'), true, 'qwen2.5:1.5b is small');
assert.strictEqual(isSmallModel('qwen2.5:3b'), true, 'qwen2.5:3b is small');
assert.strictEqual(isSmallModel('gpt-4o-mini'), false, 'gpt-4o-mini is not small');
assert.strictEqual(isSmallModel('gpt-5.2'), false, 'gpt-5.2 is not small');
assert.strictEqual(isSmallModel('llama3.1:70b'), false, 'llama3.1:70b is not small');
assert.strictEqual(isSmallModel(''), false, 'empty string is not small');
assert.strictEqual(isSmallModel(null), false, 'null is not small');

// --- Unit: instructions endpoint ---
const PORT = 18086;
const BASE = `http://127.0.0.1:${PORT}`;
let defaultAuth = 'betman:change-me-now';
try {
  const authFile = path.join(ROOT, 'memory', 'betman-auth.json');
  const cfg = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  if (cfg?.username && cfg?.password) defaultAuth = `${cfg.username}:${cfg.password}`;
} catch {}
const AUTH = Buffer.from(defaultAuth).toString('base64');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async function main(){
  const env = {
    ...process.env,
    PORT: String(PORT),
    BETMAN_FAKE_AI: 'true',
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_OLLAMA_BASE_URL: process.env.BETMAN_OLLAMA_BASE_URL || 'http://office.waihekewater.com:11434',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-fake'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], { env, stdio: 'ignore' });

  try {
    await sleep(1800);

    // Test /api/instructions returns real instructions content
    const res = await fetch(`${BASE}/api/instructions`, {
      headers: { 'Authorization': `Basic ${AUTH}` }
    });
    assert.strictEqual(res.status, 200, 'instructions status');
    const text = await res.text();
    assert.ok(text.length > 50, 'instructions should have substantial content');
    assert.ok(text.includes('punter'), 'instructions should contain punter keyword');
    assert.ok(text.includes('Speed Map'), 'instructions should contain Speed Map section');
    assert.ok(!text.includes('No additional instructions'), 'instructions should not be the stub');

    console.log('ai_analyse_fixes tests passed');
  } finally {
    server.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});

// --- Integration: Ollama /api/chat payload & num_ctx configuration ---
const OLLAMA_PORT = 18087;
const BETMAN_PORT2 = 18088;

let lastOllamaRequest = null;

const mockOllama = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }, { name: 'llama3.1:8b' }] }));
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try { lastOllamaRequest = { url: req.url, body: JSON.parse(body) }; } catch { lastOllamaRequest = { url: req.url, body: {} }; }
    // Return a valid /api/chat response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'Trentham Race 5 looks good. Top pick: Horse A.' }, done: true }));
  });
});

(async function ollamaChatPayloadTest(){
  await new Promise(r => mockOllama.listen(OLLAMA_PORT, r));

  const env2 = {
    ...process.env,
    PORT: String(BETMAN_PORT2),
    BETMAN_FAKE_AI: 'false',
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_OLLAMA_BASE_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
    BETMAN_WEB_SEARCH_TIMEOUT_MS: '200',
    BETMAN_WEB_PAGE_TIMEOUT_MS: '200',
    OPENAI_API_KEY: 'sk-test-fake'
  };

  let defaultAuth2 = 'betman:change-me-now';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT,'memory','betman-auth.json'),'utf8'));
    if (cfg?.username && cfg?.password) defaultAuth2 = `${cfg.username}:${cfg.password}`;
  } catch {}
  const AUTH2 = Buffer.from(defaultAuth2).toString('base64');
  const sleep2 = ms => new Promise(r => setTimeout(r, ms));

  const server2 = spawn('node', ['scripts/frontend_server.js'], { env: env2, cwd: ROOT, stdio: 'ignore' });

  try {
    await sleep2(2000);

    // Small model: qwen2.5:1.5b — verify /api/chat, num_ctx floor=8192
    lastOllamaRequest = null;
    const r1 = await fetch(`http://127.0.0.1:${BETMAN_PORT2}/api/ask-selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH2}` },
      body: JSON.stringify({
        source: 'race-analysis',
        question: 'Analyse Trentham R5',
        provider: 'ollama',
        model: 'qwen2.5:1.5b',
        selectionCount: 0,
        selections: [],
        uiContext: {},
        raceContext: { meeting: 'Trentham', raceNumber: '5', raceName: 'Test' }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const b1 = await r1.json();
    assert.strictEqual(r1.status, 200, 'qwen small model: http status');
    assert.ok(b1?.answer, 'qwen small model: answer present');

    assert.ok(lastOllamaRequest, 'ollama request captured');
    assert.strictEqual(lastOllamaRequest.url, '/api/chat', 'ollama must use /api/chat not /api/generate');
    assert.ok(Array.isArray(lastOllamaRequest.body?.messages), 'ollama payload must have messages array');
    assert.ok(lastOllamaRequest.body?.messages?.length >= 2, 'messages must have at least system + user');
    assert.ok(lastOllamaRequest.body?.messages?.some(m => m.role === 'system'), 'messages must include system role');
    assert.ok(lastOllamaRequest.body?.messages?.some(m => m.role === 'user'), 'messages must include user role');
    assert.ok(typeof lastOllamaRequest.body?.options?.num_ctx === 'number', 'num_ctx must be set');
    assert.ok(lastOllamaRequest.body?.options?.num_ctx >= 8192, `num_ctx must be ≥8192 for small model, got ${lastOllamaRequest.body?.options?.num_ctx}`);
    assert.ok(typeof lastOllamaRequest.body?.options?.num_predict === 'number', 'num_predict must be set');
    assert.ok(typeof lastOllamaRequest.body?.options?.temperature === 'number', 'temperature must be set');
    assert.strictEqual(lastOllamaRequest.body?.stream, false, 'stream must be false');

    // Large model: llama3.1:70b — verify larger num_ctx floor
    lastOllamaRequest = null;
    const r2 = await fetch(`http://127.0.0.1:${BETMAN_PORT2}/api/ask-selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH2}` },
      body: JSON.stringify({
        source: 'race-analysis',
        question: 'Analyse Flemington R7',
        provider: 'ollama',
        model: 'llama3.1:70b',
        selectionCount: 0,
        selections: [],
        uiContext: {},
        raceContext: { meeting: 'Flemington', raceNumber: '7', raceName: 'Test' }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const b2 = await r2.json();
    assert.strictEqual(r2.status, 200, 'large model: http status');
    assert.ok(b2?.answer, 'large model: answer present');
    assert.ok(lastOllamaRequest?.body?.options?.num_ctx >= 16384, `large model num_ctx must be ≥16384, got ${lastOllamaRequest?.body?.options?.num_ctx}`);

    console.log('ai_analyse_fixes ollama payload tests passed');
  } finally {
    server2.kill('SIGTERM');
    mockOllama.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
