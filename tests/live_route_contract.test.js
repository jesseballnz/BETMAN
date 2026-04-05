#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18124;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = Buffer.from('betman:test-only-password').toString('base64');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(timeoutMs = 12000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not become ready on ${BASE} within ${timeoutMs}ms`);
}

(async function main() {
  const child = spawn('node', ['scripts/frontend_server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      BETMAN_PASSWORD: 'test-only-password',
      BETMAN_FAKE_AI: 'true',
      BETMAN_AI_CACHE_ENABLED: 'false',
      AI_CACHE_ENABLED: 'false',
    },
    stdio: 'ignore',
  });

  try {
    await waitForReady();

    const settled = await fetch(`${BASE}/api/v1/settled-bets`, {
      headers: { Authorization: `Basic ${AUTH}` },
    });
    assert.notStrictEqual(settled.status, 404, '/api/v1/settled-bets must not 404');

    const ask = await fetch(`${BASE}/api/ask-betman`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${AUTH}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'What changed?', provider: 'ollama', model: 'llama3.1:8b' }),
    });
    assert.notStrictEqual(ask.status, 404, '/api/ask-betman must not 404');

    const genericChat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.strictEqual(genericChat.status, 404, '/api/chat should remain unsupported by BETMAN');
    const genericChatBody = await genericChat.json();
    assert.strictEqual(genericChatBody.error, 'wrong_api_surface');
    assert.strictEqual(genericChatBody.expected, '/api/ask-betman');

    const ollamaShow = await fetch(`${BASE}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'llama3.1:8b' }),
    });
    assert.strictEqual(ollamaShow.status, 404, '/api/show should remain unsupported by BETMAN');
    const ollamaShowBody = await ollamaShow.json();
    assert.strictEqual(ollamaShowBody.error, 'wrong_api_surface');
    assert(/Ollama/i.test(String(ollamaShowBody.expected || '')));

    const ollamaDelete = await fetch(`${BASE}/api/delete`, {
      method: 'DELETE',
    });
    assert.strictEqual(ollamaDelete.status, 404, '/api/delete should remain unsupported by BETMAN');
    const ollamaDeleteBody = await ollamaDelete.json();
    assert.strictEqual(ollamaDeleteBody.error, 'wrong_api_surface');
    assert(/Ollama/i.test(String(ollamaDeleteBody.expected || '')));

    console.log('live_route_contract tests passed');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
