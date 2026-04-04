#!/usr/bin/env node
/**
 * BETMAN Commercial API v1 — unit tests
 * Covers: API key generation, extraction, rate limiting, handler wiring,
 *         response format, auth enforcement, admin TAB proxy gating.
 */
'use strict';

const assert = require('assert');
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

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'frontend', 'data');

function makeHandler(overrides = {}) {
  return createApiHandler({
    getAuthState: overrides.getAuthState || (() => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] })),
    saveAuthState: overrides.saveAuthState || (() => {}),
    loadJson: overrides.loadJson || ((p, f) => f),
    resolveTenantPath: overrides.resolveTenantPath || ((req, dp) => dp),
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
  const res = fakeRes();
  apiJson(res, { ok: true, test: 'value' }, 200, { limit: 60, remaining: 59, window: 60 });
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
  const res = fakeRes();
  apiError(res, 401, 'api_key_required', 'Provide an API key.');
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

// 12. Race detail endpoint
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

/* ── Non-admin API key persistence & auth tests ──────────────────── */

// 22. Non-admin key is persisted to users[idx].apiKeys via saveAuthState
asyncTests.push((async () => {
  let savedState = null;
  const adminKey = generateApiKey();
  const userEmail = 'punter@example.com';

  const state = {
    username: 'admin', password: 'pass',
    adminApiKeys: [{ key: adminKey, label: 'Admin', active: true }],
    users: [{ username: userEmail, password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [] }]
  };

  const handler = makeHandler({
    getAuthState: () => state,
    saveAuthState: (next) => { savedState = next; Object.assign(state, next); }
  });

  // Admin creates key for non-admin user
  const req = fakePostReq('/api/v1/keys', { username: userEmail, label: 'Punter Key' }, { 'x-api-key': adminKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/keys');
  await handler(req, res, url);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(res.statusCode, 201, `expected 201 but got ${res.statusCode}: ${res.body}`);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.ok(parsed.key.startsWith('bm_'), 'returned key should start with bm_');
  assert.strictEqual(parsed.username, userEmail);

  // Verify the key was persisted via saveAuthState
  assert.ok(savedState, 'saveAuthState should have been called');
  const savedUser = savedState.users.find(u => u.username === userEmail);
  assert.ok(savedUser, 'user should exist in saved state');
  assert.ok(Array.isArray(savedUser.apiKeys), 'user should have apiKeys array');
  assert.strictEqual(savedUser.apiKeys.length, 1, 'user should have exactly 1 API key');
  assert.strictEqual(savedUser.apiKeys[0].key, parsed.key, 'saved key should match returned key');
  assert.strictEqual(savedUser.apiKeys[0].active, true, 'key should be active');
  console.log('  ✓ Non-admin key persisted to users[idx].apiKeys via saveAuthState');
})());

// 23. Persisted non-admin key authenticates /api/v1/me
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'stripe_user@test.com', password: 'hashed', role: 'user', tenantId: 'default', planType: 'commercial', apiKeys: [{ key: userKey, label: 'My Key', active: true, rateLimit: 60, rateWindow: 60 }] }]
    })
  });
  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/me');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.user.username, 'stripe_user@test.com');
  assert.strictEqual(parsed.user.isAdmin, false);
  assert.strictEqual(parsed.user.planType, 'commercial');
  console.log('  ✓ Persisted non-admin key authenticates /api/v1/me');
})());

// 24. Persisted non-admin key authenticates /api/v1/races
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'user@test.com', password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [{ key: userKey, label: 'Key', active: true }] }]
    }),
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [{ meeting: 'Ellerslie', race_number: '1', country: 'NZ', runners: [] }] };
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.count, 1);
  console.log('  ✓ Persisted non-admin key authenticates /api/v1/races');
})());

// 25. Persisted non-admin key authenticates /api/v1/suggested-bets
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'user@test.com', password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [{ key: userKey, label: 'Key', active: true }] }]
    }),
    loadJson: (p, f) => {
      if (p.includes('status.json')) return { suggestedBets: [{ meeting: 'Pukekohe', race: '2', selection: 'Star', type: 'Win' }] };
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/suggested-bets', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/suggested-bets');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.count, 1);
  console.log('  ✓ Persisted non-admin key authenticates /api/v1/suggested-bets');
})());

// 26. Persisted non-admin key authenticates /api/v1/status
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'user@test.com', password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [{ key: userKey, label: 'Key', active: true }] }]
    }),
    loadJson: (p, f) => {
      if (p.includes('status.json')) return { balance: 100, openBets: 3 };
      return f;
    }
  });
  const req = fakeReq('GET', '/api/v1/status', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/status');
  await handler(req, res, url);
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.balance, 100);
  console.log('  ✓ Persisted non-admin key authenticates /api/v1/status');
})());

// 27. Invalid key fails all protected endpoints
asyncTests.push((async () => {
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'user@test.com', password: 'hash', role: 'user', tenantId: 'default', apiKeys: [{ key: generateApiKey(), label: 'Real', active: true }] }]
    })
  });
  const endpoints = ['/api/v1/me', '/api/v1/races', '/api/v1/suggested-bets', '/api/v1/status', '/api/v1/keys'];
  for (const ep of endpoints) {
    const req = fakeReq('GET', ep, { 'x-api-key': 'bm_totally_bogus_key_that_does_not_exist' });
    const res = fakeRes();
    const url = new URL(`http://localhost${ep}`);
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 401, `${ep} should return 401 for invalid key`);
    assert.strictEqual(JSON.parse(res.body).error, 'invalid_api_key', `${ep} should return invalid_api_key`);
  }
  console.log('  ✓ Invalid key returns 401 on all protected endpoints');
})());

// 28. Admin key still works after non-admin key creation (adminApiKeys persistence)
asyncTests.push((async () => {
  let savedState = null;
  const adminKey = generateApiKey();
  const state = {
    username: 'admin', password: 'pass',
    adminApiKeys: [{ key: adminKey, label: 'Admin', active: true }],
    users: [{ username: 'user@test.com', password: 'hash', role: 'user', tenantId: 'default', apiKeys: [] }]
  };
  const handler = makeHandler({
    getAuthState: () => state,
    saveAuthState: (next) => {
      savedState = next;
      Object.assign(state, next);
      // Simulate saveAuthState preserving adminApiKeys (the fix)
      if (Array.isArray(next.adminApiKeys)) state.adminApiKeys = next.adminApiKeys;
    }
  });

  // Admin creates key for user
  const createReq = fakePostReq('/api/v1/keys', { username: 'user@test.com', label: 'User Key' }, { 'x-api-key': adminKey });
  const createRes = fakeRes();
  await handler(createReq, createRes, new URL('http://localhost/api/v1/keys'));
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(createRes.statusCode, 201);

  // Admin key should still work
  const meReq = fakeReq('GET', '/api/v1/me', { 'x-api-key': adminKey });
  const meRes = fakeRes();
  await handler(meReq, meRes, new URL('http://localhost/api/v1/me'));
  assert.strictEqual(meRes.statusCode, 200);
  assert.strictEqual(JSON.parse(meRes.body).user.isAdmin, true);

  // Verify adminApiKeys was preserved in saved state
  assert.ok(savedState.adminApiKeys, 'adminApiKeys should be in saved state');
  assert.strictEqual(savedState.adminApiKeys.length, 1, 'admin should still have 1 key');
  console.log('  ✓ Admin key still works after non-admin key creation');
})());

// 29. Email normalisation — case-insensitive user lookup
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'User@Example.COM', password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [{ key: userKey, label: 'Key', active: true }] }]
    })
  });
  // Key should authenticate even though stored username has mixed case
  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': userKey });
  const res = fakeRes();
  await handler(req, res, new URL('http://localhost/api/v1/me'));
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.user.username, 'User@Example.COM');
  console.log('  ✓ Email normalisation — mixed-case username authenticates');
})());

// 30. Plus-addressed email key lookup
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [],
      users: [{ username: 'user+test@example.com', password: 'hash', role: 'user', tenantId: 'default', planType: 'single', apiKeys: [{ key: userKey, label: 'Key', active: true }] }]
    })
  });
  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': userKey });
  const res = fakeRes();
  await handler(req, res, new URL('http://localhost/api/v1/me'));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).user.username, 'user+test@example.com');
  console.log('  ✓ Plus-addressed email key lookup works');
})());

// 31. Admin key creation via POST /api/v1/keys persists to adminApiKeys
asyncTests.push((async () => {
  let savedState = null;
  const adminKey = generateApiKey();
  const state = {
    username: 'admin', password: 'pass',
    adminApiKeys: [{ key: adminKey, label: 'Admin', active: true }],
    users: []
  };
  const handler = makeHandler({
    getAuthState: () => state,
    saveAuthState: (next) => { savedState = next; Object.assign(state, next); }
  });

  const req = fakePostReq('/api/v1/keys', { label: 'New Admin Key' }, { 'x-api-key': adminKey });
  const res = fakeRes();
  await handler(req, res, new URL('http://localhost/api/v1/keys'));
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(res.statusCode, 201);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.key.startsWith('bm_'));

  // adminApiKeys should have the new key
  assert.ok(savedState.adminApiKeys, 'adminApiKeys should be in saved state');
  assert.strictEqual(savedState.adminApiKeys.length, 2, 'admin should have 2 keys now');
  console.log('  ✓ Admin key creation persists to adminApiKeys');
})());

// 32. Non-admin key lists only own keys
asyncTests.push((async () => {
  const userKey = generateApiKey();
  const otherKey = generateApiKey();
  const handler = makeHandler({
    getAuthState: () => ({
      username: 'admin', password: 'pass',
      adminApiKeys: [{ key: generateApiKey(), label: 'Admin', active: true }],
      users: [
        { username: 'alice@test.com', password: 'hash', role: 'user', tenantId: 'default', apiKeys: [{ key: userKey, label: 'Alice Key', active: true }] },
        { username: 'bob@test.com', password: 'hash', role: 'user', tenantId: 'default', apiKeys: [{ key: otherKey, label: 'Bob Key', active: true }] }
      ]
    })
  });
  const req = fakeReq('GET', '/api/v1/keys', { 'x-api-key': userKey });
  const res = fakeRes();
  await handler(req, res, new URL('http://localhost/api/v1/keys'));
  assert.strictEqual(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.keys.length, 1, 'non-admin should see only their own keys');
  assert.strictEqual(parsed.keys[0].label, 'Alice Key');
  console.log('  ✓ Non-admin key list shows only own keys');
})());

// 33. normalizeUsername export works correctly
{
  const { normalizeUsername } = require('../scripts/betman_api');
  assert.strictEqual(normalizeUsername('User@Example.COM'), 'user@example.com', 'email should be lowercased');
  assert.strictEqual(normalizeUsername('admin'), 'admin', 'non-email should be unchanged');
  assert.strictEqual(normalizeUsername('  user@test.com  '), 'user@test.com', 'should trim whitespace');
  assert.strictEqual(normalizeUsername(null), '', 'null should return empty');
  assert.strictEqual(normalizeUsername(undefined), '', 'undefined should return empty');
  assert.strictEqual(normalizeUsername('user+tag@test.com'), 'user+tag@test.com', 'plus-addressed should be preserved');
  console.log('  ✓ normalizeUsername handles all cases');
}

// Wait for all async tests to complete
Promise.all(asyncTests).then(() => {
  console.log('betman_api tests passed');
  process.exit(0);
}).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
