#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function runServer(extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/frontend_server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '18123',
        BETMAN_FAKE_AI: 'true',
        BETMAN_AI_CACHE_ENABLED: 'false',
        AI_CACHE_ENABLED: 'false',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on('data', (d) => { stdout += String(d || ''); });
    child.stderr.on('data', (d) => { stderr += String(d || ''); });
    child.on('exit', (code, signal) => finish({ code, signal, stdout, stderr }));

    setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish({ code: null, signal: 'SIGTERM', stdout, stderr });
    }, 2500);
  });
}

(async function main(){
  const missingPassword = await runServer({ BETMAN_PASSWORD: '' });
  const combinedMissing = `${missingPassword.stdout}\n${missingPassword.stderr}`;
  assert(combinedMissing.includes('BETMAN_PASSWORD is required'), 'server should fail closed without BETMAN_PASSWORD');

  const validPassword = await runServer({ BETMAN_PASSWORD: 'test-only-password' });
  const combinedValid = `${validPassword.stdout}\n${validPassword.stderr}`;
  assert(combinedValid.includes('frontend server running'), 'server should start when BETMAN_PASSWORD is set');

  console.log('startup_config_validation tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
