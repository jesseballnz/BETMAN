#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'scripts', 'frontend_server.js');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(baseUrl, timeoutMs = 12000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server did not become ready on ${baseUrl} within ${timeoutMs}ms`);
}

(async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'betman-key-rotation-'));
  const port = 18161 + Math.floor(Math.random() * 200);
  const baseUrl = `http://localhost:${port}`;
  const oldAdminKey = 'bm_legacy_rotation_regression_old_key_1234567890';

  fs.mkdirSync(path.join(tmpRoot, 'frontend', 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'instructions'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'frontend', 'data', 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    apiStatusPublic: 'OK',
    apiStatusDetail: {
      smokeFresh: true,
      smokePresent: true,
      smokeCheckedAt: new Date().toISOString(),
    }
  }, null, 2));
  fs.writeFileSync(path.join(tmpRoot, 'frontend', 'data', 'races.json'), JSON.stringify({ races: [] }, null, 2));
  fs.writeFileSync(path.join(tmpRoot, 'frontend', 'index.html'), '<!doctype html><title>BETMAN test</title>');
  fs.writeFileSync(path.join(tmpRoot, 'instructions', 'instructions.md'), 'Test instructions');
  fs.writeFileSync(path.join(tmpRoot, 'memory', 'betman-auth.json'), JSON.stringify({
    username: 'betman',
    password: 'test-only-password',
    users: [],
    adminMeta: {
      apiKeyHash: sha256(oldAdminKey),
      apiKeyCreatedAt: new Date().toISOString(),
      apiKeyPreview: oldAdminKey.slice(-6),
    },
    adminApiKeys: []
  }, null, 2));

  const child = spawn('node', [SERVER_SCRIPT], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BETMAN_PASSWORD: 'test-only-password',
      BETMAN_FAKE_AI: 'true',
      BETMAN_AI_CACHE_ENABLED: 'false',
      AI_CACHE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d || ''); });
  child.stderr.on('data', (d) => { stderr += String(d || ''); });

  try {
    await waitForReady(baseUrl);

    const before = await fetch(`${baseUrl}/api/race-analysis/list`, {
      headers: { 'X-API-Key': oldAdminKey },
    });
    assert.strictEqual(before.status, 200, 'legacy admin key should authenticate before rotation');

    const rotate = await fetch(`${baseUrl}/api/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': oldAdminKey,
      },
      body: JSON.stringify({ label: 'Rotated admin key' }),
    });
    assert.strictEqual(rotate.status, 201, `rotation request failed: ${rotate.status}`);
    const rotateBody = await rotate.json();
    assert.ok(rotateBody.key, 'rotation should return the new key once');
    const newAdminKey = rotateBody.key;
    assert.notStrictEqual(newAdminKey, oldAdminKey, 'rotated key must differ from the old key');

    const oldAfter = await fetch(`${baseUrl}/api/race-analysis/list`, {
      headers: { 'X-API-Key': oldAdminKey },
    });
    assert.strictEqual(oldAfter.status, 401, 'old admin key should be rejected after rotation');

    const freshAfter = await fetch(`${baseUrl}/api/race-analysis/list`, {
      headers: { 'X-API-Key': newAdminKey },
    });
    assert.strictEqual(freshAfter.status, 200, 'new admin key should authenticate after rotation');

    console.log('frontend_api_key_rotation_regression tests passed');
  } catch (err) {
    if (stdout || stderr) {
      console.error('--- frontend server stdout ---');
      if (stdout) console.error(stdout.trim());
      console.error('--- frontend server stderr ---');
      if (stderr) console.error(stderr.trim());
    }
    throw err;
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
