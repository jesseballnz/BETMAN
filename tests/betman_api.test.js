#!/usr/bin/env node
/**
 * BETMAN Commercial API v1 — unit tests
 * Covers: API key generation, extraction, rate limiting, handler wiring,
 *         response format, auth enforcement, admin TAB proxy gating.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateApiKey,
  extractApiKey,
  rateCheck,
  apiJson,
  apiError,
  createApiHandler,
  API_VERSION,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW
} = require('../scripts/betman_api');

/* ── Helpers ───────────────────────────────────────────────────────── */
function fakeRes() {
  const r = {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, hdrs) { r.statusCode = code; Object.assign(r.headers, hdrs || {}); r.headersSent = true; },
    end(data) { r.body = String(data || ''); }
  };
  return r;
}

function fakeReq(method, urlStr, headers = {}) {
  return {
    method,
    url: urlStr,
    headers: { host: 'localhost', ...headers },
    on(ev, cb) {
      if (ev === 'end') setTimeout(cb, 0);
    }
  };
}

function fakePostReq(urlStr, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST',
    url: urlStr,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    on(ev, cb) {
      if (ev === 'data') cb(bodyStr);
      if (ev === 'end') setTimeout(cb, 0);
    }
  };
}

function fakePutReq(urlStr, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'PUT',
    url: urlStr,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    on(ev, cb) {
      if (ev === 'data') cb(bodyStr);
      if (ev === 'end') setTimeout(cb, 0);
    }
  };
}

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'frontend', 'data');

function makeHandler(overrides = {}) {
  return createApiHandler({
    getAuthState: overrides.getAuthState || (() => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] })),
    saveAuthState: overrides.saveAuthState || (() => {}),
    loadJson: overrides.loadJson || ((p, f) => f),
    resolveTenantPath: overrides.resolveTenantPath || ((req, dp) => dp),
    getSessionPrincipal: overrides.getSessionPrincipal,
    resolveTenantPathById: overrides.resolveTenantPathById,
    dataDir: overrides.dataDir || DATA_DIR,
    rootDir: overrides.rootDir || ROOT
  });
}

/* ── Synchronous tests ─────────────────────────────────────────────── */

// 1. API key generation
const key1 = generateApiKey();
const key2 = generateApiKey();
assert(key1.startsWith('bm_'), 'API key should start with bm_ prefix');
assert.strictEqual(key1.length, 51, 'API key should be bm_ + 48 hex chars = 51 chars');
assert.notStrictEqual(key1, key2, 'Two generated keys should be different');
console.log('  ✓ generateApiKey produces unique prefixed keys');

// 2. API key extraction
{
  const url = new URL('http://localhost/api/v1/races');
  const req1 = { headers: { 'x-api-key': 'bm_test123' } };
  assert.strictEqual(extractApiKey(req1, url), 'bm_test123');

  const url2 = new URL('http://localhost/api/v1/races?api_key=bm_query456');
  const req2 = { headers: {} };
  assert.strictEqual(extractApiKey(req2, url2), 'bm_query456');

  const req3 = { headers: { 'x-api-key': 'bm_header' } };
  const url3 = new URL('http://localhost/api/v1/races?api_key=bm_query');
  assert.strictEqual(extractApiKey(req3, url3), 'bm_header');

  const req4 = { headers: {} };
  const url4 = new URL('http://localhost/api/v1/races');
  assert.strictEqual(extractApiKey(req4, url4), null);
}
console.log('  ✓ extractApiKey handles header, query param, precedence, and missing key');

// 3. Rate limiting
{
  const testKey = 'rate_test_' + Date.now();
  const r1 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);

  const r2 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  const r3 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  const r4 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r4.allowed, false);
  assert(r4.retryAfter > 0);
}
console.log('  ✓ rateCheck enforces sliding window limits');

// 4. apiJson response format
{
  const req = fakeReq('GET', '/api/v1/health');
  const res = fakeRes();
  apiJson(req, res, { ok: true, test: 'value' }, 200, { limit: 60, remaining: 59, window: 60 });
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.test, 'value');
  assert.strictEqual(res.headers['X-RateLimit-Limit'], '60');
  assert.strictEqual(res.headers['X-RateLimit-Remaining'], '59');
}
console.log('  ✓ apiJson formats response with rate limit headers');

// 5. apiError response format
{
  const req = fakeReq('GET', '/api/v1/health');
  const res = fakeRes();
  apiError(req, res, 401, 'api_key_required', 'Provide an API key.');
  assert.strictEqual(res.statusCode, 401);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.error, 'api_key_required');
  assert.strictEqual(parsed.api_version, API_VERSION);
}
console.log('  ✓ apiError returns structured error with version');

// 6. Constants exported correctly
assert.strictEqual(typeof API_VERSION, 'string');
assert(API_VERSION.match(/^\d+\.\d+\.\d+$/));
assert.strictEqual(typeof DEFAULT_RATE_LIMIT, 'number');
assert.strictEqual(typeof DEFAULT_RATE_WINDOW, 'number');
console.log('  ✓ Module constants exported correctly');

/* ── Async tests ───────────────────────────────────────────────────── */

const asyncTests = [];

// 7. Auth enforcement — no API key
asyncTests.push((async () => {
  const handler = makeHandler();
  const req = fakeReq('GET', '/api/v1/races');
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  const handled = await handler(req, res, url);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).error, 'api_key_required');
  console.log('  ✓ Auth enforcement — missing key returns 401');
})());

// 8. Auth enforcement — invalid key
asyncTests.push((async () => {
  const handler = makeHandler();
  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': 'bm_invalid' });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).error, 'invalid_api_key');
  console.log('  ✓ Auth enforcement — invalid key returns 401');
})());

// 9. Revoked key rejected
asyncTests.push((async () => {
  const revokedKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: revokedKey, label: 'Revoked', active: false }] })
  });
  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': revokedKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 401);
  console.log('  ✓ Revoked key rejected');
})());

// 10. Health endpoint is public
asyncTests.push((async () => {
  const handler = makeHandler();
  const req = fakeReq('GET', '/api/v1/health');
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/health');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert(parsed.timestamp);
  assert.strictEqual(parsed.api_version, API_VERSION);
  console.log('  ✓ Health endpoint is public');
})());

// 11. Races endpoint
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true, rateLimit: 100, rateWindow: 60 }] }),
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '3', description: 'Maiden 1200m', distance: '1200m', country: 'NZ', runners: [{ name: 'Star Runner', runner_number: '1', odds: 3.5 }] }
      ]};
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.count, 1);
  assert.strictEqual(parsed.races[0].meeting, 'Pukekohe');
  assert(res.headers['X-RateLimit-Remaining'] !== undefined);
  console.log('  ✓ Races endpoint returns data with rate headers');
})());

// 12. Pulse config route supports PUT + filtered alerts by tenant
asyncTests.push((async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'betman-api-pulse-'));
  const dataDir = path.join(tmpRoot, 'frontend', 'data');
  const tenantDir = path.join(tmpRoot, 'memory', 'tenants', 'acct_test', 'frontend-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tenantDir, { recursive: true });

  fs.writeFileSync(path.join(tenantDir, 'alerts_feed.json'), JSON.stringify({
    updatedAt: '2026-03-31T00:00:00.000Z',
    alerts: [
      { id: '1', type: 'hot_plunge', selection: 'A' },
      { id: '2', type: 'hot_drift', selection: 'B' },
      { id: '3', type: 'market_conflict', selection: 'C' }
    ]
  }, null, 2));

  const loadJson = (p, f) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; }
  };
  const resolveTenantPathById = (tenantId, defaultPath, filename) => {
    if (tenantId === 'acct_test') return path.join(tmpRoot, 'memory', 'tenants', tenantId, 'frontend-data', filename);
    return defaultPath;
  };

  const handler = makeHandler({
    dataDir,
    rootDir: tmpRoot,
    loadJson,
    getSessionPrincipal: () => ({ username: 'alice', tenantId: 'acct_test', effectiveTenantId: 'acct_test' }),
    resolveTenantPathById,
  });

  const putReq = fakePutReq('/api/v1/pulse-config', { alertTypes: { drifts: false } });
  const putRes = fakeRes();
  await handler(putReq, putRes, new URL('http://localhost/api/v1/pulse-config'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(putRes.statusCode, 200);
  const saved = JSON.parse(putRes.body);
  assert.strictEqual(saved.config.alertTypes.drifts, false);

  const getReq = fakeReq('GET', '/api/v1/alerts-feed');
  const getRes = fakeRes();
  await handler(getReq, getRes, new URL('http://localhost/api/v1/alerts-feed'));
  assert.strictEqual(getRes.statusCode, 200);
  const feed = JSON.parse(getRes.body);
  assert.strictEqual(feed.alerts.length, 2);
  assert.strictEqual(feed.alerts.some((row) => row.type === 'hot_drift'), false);
  console.log('  ✓ Pulse config route persists and filters tenant alerts');
})());

// 13. Race detail endpoint
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] }),
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '5', distance: '1400m', runners: [{ name: 'Thunder', runner_number: '2', odds: 5.0 }] }
      ]};
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/races/pukekohe/5', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races/pukekohe/5');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.race.meeting, 'Pukekohe');
  assert.strictEqual(parsed.race.runners[0].name, 'Thunder');
  console.log('  ✓ Race detail endpoint');
})());

// 13. Suggested bets endpoint
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] }),
    loadJson: (p, f) => {
      if (p.includes('status.json')) return {
        updatedAt: '2026-03-26T00:00:00Z',
        suggestedBets: [
          { meeting: 'Ellerslie', race: '4', selection: 'Fast Horse', type: 'Win', aiWinProb: 45 },
          { meeting: 'Ellerslie', race: '4', selection: 'Fast Horse / Slow Horse', type: 'Top2', stake: 1 }
        ]
      };
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/suggested-bets', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/suggested-bets');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.count, 2);
  assert.strictEqual(parsed.wins.length, 1, 'should have 1 win bet');
  assert.strictEqual(parsed.wins[0].selection, 'Fast Horse');
  assert.strictEqual(parsed.exotics.length, 1, 'should have 1 exotic bet');
  assert.strictEqual(parsed.exotics[0].type, 'Top2');
  assert.strictEqual(parsed.all.length, 2, 'all should contain both');
  console.log('  ✓ Suggested bets endpoint');
})());

// 14. /me endpoint — admin
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] })
  });
  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/me');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.user.username, 'admin');
  assert.strictEqual(parsed.user.isAdmin, true);
  console.log('  ✓ /me endpoint — admin');
})());

// 15. /me endpoint — regular user
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      users: [{ username: 'punter@test.com', password: 'pass', role: 'user', tenantId: 'acct_punter', planType: 'single', apiKeys: [{ key: userKey, label: 'Punter', active: true }] }],
      adminApiKeys: []
    })
  });
  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/me');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.user.username, 'punter@test.com');
  assert.strictEqual(parsed.user.isAdmin, false);
  assert.strictEqual(parsed.user.planType, 'single');
  console.log('  ✓ /me endpoint — regular user');
})());

// 16. Non-admin blocked from TAB proxy
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      users: [{ username: 'user@test.com', password: 'pass', role: 'user', tenantId: 'default', apiKeys: [{ key: userKey, label: 'User', active: true }] }],
      adminApiKeys: []
    })
  });
  const req = fakeReq('GET', '/api/v1/tab/meetings', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/tab/meetings');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(JSON.parse(res.body).error, 'admin_required');
  console.log('  ✓ Non-admin blocked from TAB proxy');
})());

// 17. 404 for unknown routes
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] })
  });
  const req = fakeReq('GET', '/api/v1/nonexistent', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/nonexistent');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(JSON.parse(res.body).error, 'not_found');
  console.log('  ✓ 404 for unknown routes');
})());

// 18. Non-v1 routes are not handled
asyncTests.push((async () => {
  const handler = makeHandler();
  const req = fakeReq('GET', '/api/health');
  const res = fakeRes();
  const url = new URL('http://localhost/api/health');
  const handled = await handler(req, res, url);
  assert.strictEqual(handled, false);
  console.log('  ✓ Non-v1 routes are not handled');
})());

// 19. ask-betman POST endpoint
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] }),
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '3', description: 'Maiden 1200m', runners: [{ name: 'Star', runner_number: '1' }] }
      ]};
      if (p.includes('status.json')) return {
        suggestedBets: [{ meeting: 'Pukekohe', race: '3', selection: 'Star', type: 'Win' }],
        marketMovers: [], interestingRunners: []
      };
      return f;
    }
  });
  const req = fakePostReq('/api/v1/ask-betman', { question: 'Who should I bet on at Pukekohe Race 3?', meeting: 'pukekohe', race: '3' }, { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/ask-betman');
  await handler(req, res, url);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert(parsed.question);
  assert(parsed.analysis);
  assert(parsed.analysis.matchedRace);
  assert.strictEqual(parsed.analysis.matchedRace.meeting, 'Pukekohe');
  console.log('  ✓ ask-betman POST endpoint');
})());

// 20. ask-betman validation — missing question
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] })
  });
  const req = fakePostReq('/api/v1/ask-betman', {}, { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/ask-betman');
  await handler(req, res, url);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).error, 'missing_question');
  console.log('  ✓ ask-betman validation — missing question');
})());

// 21. Models endpoint
asyncTests.push((async () => {
  const testKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [{ key: testKey, label: 'Test', active: true }] })
  });
  const req = fakeReq('GET', '/api/v1/models', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/models');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.ok, 'response should be ok');
  assert.ok(parsed.defaultProvider, 'should have defaultProvider');
  assert.ok(parsed.defaultModel, 'should have defaultModel');
  assert.ok(Array.isArray(parsed.models), 'should have models array');
  assert.ok(parsed.models.length > 0, 'should have at least one model');
  // Each model should have name, provider, profile
  const m = parsed.models[0];
  assert.ok(m.name, 'model should have name');
  assert.ok(m.provider, 'model should have provider');
  assert.ok(m.profile, 'model should have profile');
  console.log('  ✓ Models endpoint');
})());

// Wait for all async tests to complete
Promise.all(asyncTests).then(() => {
  console.log('betman_api tests passed');
  process.exit(0);
}).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
