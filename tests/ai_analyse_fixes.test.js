#!/usr/bin/env node
const assert = require('assert');
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
