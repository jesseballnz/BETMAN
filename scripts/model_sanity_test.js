#!/usr/bin/env node
const path = require('path');

function arg(name, dflt = '') {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : dflt;
}

function inferProvider(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('gpt-')) return 'openai';
  return 'ollama';
}

async function main() {
  const explicitUrl = arg('url', '') || process.env.BAKEOFF_URL || '';

  if (!explicitUrl) {
    console.log('[SKIP] No BAKEOFF_URL configured — model sanity test requires a running BETMAN server.');
    console.log('[SKIP] Set BAKEOFF_URL (and optionally BAKEOFF_USER / BAKEOFF_PASS) to enable this test.');
    return;
  }

  const baseUrl = explicitUrl.replace(/\/$/, '');

  const user = arg('user', process.env.BAKEOFF_USER || process.env.BETMAN_USER || '');
  const pass = arg('pass', process.env.BAKEOFF_PASS || process.env.BETMAN_PASS || '');
  const question = arg('question', 'Sanity check: confirm this model can answer a simple BETMAN prompt.');
  const models = (arg('models', process.env.BAKEOFF_MODELS || 'deepseek-r1:8b,llama3.1:8b,gpt-4o-mini,gpt-5.2') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!models.length) throw new Error('No models specified');

  const headers = { 'Content-Type': 'application/json' };
  if (user && pass) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  const results = [];
  for (const model of models) {
    const provider = inferProvider(model);
    const started = Date.now();
    let res = null;
    let ok = false;
    let error = null;
    try {
      const r = await fetch(`${baseUrl}/api/ask-selection`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ question, model, provider })
      });
      const body = await r.json().catch(() => ({}));
      ok = !!(r.ok && body && body.ok);
      res = body;
      if (!ok) {
        error = body?.error || body?.fallbackReason || `status_${r.status}`;
      }
    } catch (e) {
      error = e.message || String(e);
    }
    const latency = Date.now() - started;
    results.push({ model, providerRequested: provider, success: ok, latencyMs: latency, error, mode: res?.mode || null, providerUsed: res?.provider || null, modelUsed: res?.modelUsed || null, fallbackReason: res?.fallbackReason || null });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${model} (${provider}) ${latency}ms` + (error ? ` :: ${error}` : ''));
  }

  const summary = {
    url: baseUrl,
    generatedAt: new Date().toISOString(),
    results
  };
  const outPath = path.join(process.cwd(), 'bakeoff', 'results', `sanity-${Date.now()}.json`);
  require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
  require('fs').writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Saved summary -> ${outPath}`);

  const failed = results.filter(r => !r.success);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('sanity_test_failed', err);
  process.exit(1);
});
