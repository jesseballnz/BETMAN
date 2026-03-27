#!/usr/bin/env node
/**
 * BETMAN Commercial API v1 — unit tests
 * Covers: API key generation, extraction, rate limiting, handler wiring,
 *         response format, auth enforcement, admin TAB proxy gating.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

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
  const u = new URL(urlStr, 'http://localhost');
  return {
    method,
    url: urlStr,
    headers: { host: 'localhost', ...headers },
    _parsedUrl: u,
    on(ev, cb) {
      if (ev === 'data') { /* no data for GET */ }
      if (ev === 'end') setTimeout(cb, 0);
    }
  };
}

function fakePostReq(urlStr, body, headers = {}) {
  const u = new URL(urlStr, 'http://localhost');
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST',
    url: urlStr,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    _parsedUrl: u,
    on(ev, cb) {
      if (ev === 'data') cb(bodyStr);
      if (ev === 'end') setTimeout(cb, 0);
    }
  };
}

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'frontend', 'data');

/* ── 1. API key generation ─────────────────────────────────────────── */
const key1 = generateApiKey();
const key2 = generateApiKey();
assert(key1.startsWith('bm_'), 'API key should start with bm_ prefix');
assert.strictEqual(key1.length, 51, 'API key should be bm_ + 48 hex chars = 51 chars');
assert.notStrictEqual(key1, key2, 'Two generated keys should be different');
console.log('  ✓ generateApiKey produces unique prefixed keys');

/* ── 2. API key extraction ─────────────────────────────────────────── */
{
  const url = new URL('http://localhost/api/v1/races');
  const req1 = { headers: { 'x-api-key': 'bm_test123' } };
  assert.strictEqual(extractApiKey(req1, url), 'bm_test123', 'Should extract from X-API-Key header');

  const url2 = new URL('http://localhost/api/v1/races?api_key=bm_query456');
  const req2 = { headers: {} };
  assert.strictEqual(extractApiKey(req2, url2), 'bm_query456', 'Should extract from query param');

  const req3 = { headers: { 'x-api-key': 'bm_header' } };
  const url3 = new URL('http://localhost/api/v1/races?api_key=bm_query');
  assert.strictEqual(extractApiKey(req3, url3), 'bm_header', 'Header should take precedence over query param');

  const req4 = { headers: {} };
  const url4 = new URL('http://localhost/api/v1/races');
  assert.strictEqual(extractApiKey(req4, url4), null, 'Should return null when no key provided');
}
console.log('  ✓ extractApiKey handles header, query param, precedence, and missing key');

/* ── 3. Rate limiting ──────────────────────────────────────────────── */
{
  const testKey = 'rate_test_' + Date.now();
  // First request should be allowed
  const r1 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r1.allowed, true, 'First request should be allowed');
  assert.strictEqual(r1.remaining, 2, 'Should have 2 remaining');

  const r2 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r2.allowed, true, 'Second request should be allowed');
  assert.strictEqual(r2.remaining, 1, 'Should have 1 remaining');

  const r3 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r3.allowed, true, 'Third request should be allowed');
  assert.strictEqual(r3.remaining, 0, 'Should have 0 remaining');

  const r4 = rateCheck(testKey, 3, 60);
  assert.strictEqual(r4.allowed, false, 'Fourth request should be rate limited');
  assert(r4.retryAfter > 0, 'retryAfter should be positive');
}
console.log('  ✓ rateCheck enforces sliding window limits');

/* ── 4. apiJson response format ────────────────────────────────────── */
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

/* ── 5. apiError response format ───────────────────────────────────── */
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

/* ── 6. API handler — auth enforcement ─────────────────────────────── */
{
  const handler = createApiHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  // No API key → 401
  const req = fakeReq('GET', '/api/v1/races');
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  (async () => {
    const handled = await handler(req, res, url);
    assert.strictEqual(handled, true, 'Should handle the route');
    assert.strictEqual(res.statusCode, 401, 'Should return 401 without API key');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'api_key_required');
  })();
}

/* ── 7. API handler — valid key + races endpoint ───────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true, rateLimit: 100, rateWindow: 60 }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '3', description: 'Maiden 1200m', distance: '1200m', country: 'NZ', runners: [{ name: 'Star Runner', runner_number: '1', odds: 3.5 }] }
      ]};
      return f;
    },
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');

  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200, 'Should return 200 for races');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.api_version, API_VERSION);
    assert.strictEqual(parsed.count, 1);
    assert.strictEqual(parsed.races[0].meeting, 'Pukekohe');
    assert(res.headers['X-RateLimit-Remaining'] !== undefined, 'Should include rate limit headers');
  })();
}

/* ── 8. API handler — invalid key ──────────────────────────────────── */
{
  const handler = createApiHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': 'bm_invalid_key' });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 401);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'invalid_api_key');
  })();
}

/* ── 9. API handler — non-admin cannot access TAB proxy ────────────── */
{
  const userKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [{ username: 'user@test.com', password: 'pass', role: 'user', tenantId: 'default', apiKeys: [{ key: userKey, label: 'User', active: true }] }],
      adminApiKeys: []
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/tab/meetings', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/tab/meetings');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 403, 'Non-admin should get 403 for TAB proxy');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'admin_required');
  })();
}

/* ── 10. API handler — health endpoint is public ───────────────────── */
{
  const handler = createApiHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/health');
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/health');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200, 'Health should be public');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert(parsed.timestamp, 'Should include timestamp');
    assert.strictEqual(parsed.api_version, API_VERSION);
  })();
}

/* ── 11. API handler — revoked key is rejected ─────────────────────── */
{
  const revokedKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: revokedKey, label: 'Revoked', active: false }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/races', { 'x-api-key': revokedKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 401, 'Revoked key should be rejected');
  })();
}

/* ── 12. API handler — suggested-bets ──────────────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => {
      if (p.includes('status.json')) return {
        updatedAt: '2026-03-26T00:00:00Z',
        suggestedBets: [
          { meeting: 'Ellerslie', race: '4', selection: 'Fast Horse', type: 'Win', aiWinProb: 45 }
        ]
      };
      return f;
    },
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/suggested-bets', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/suggested-bets');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.count, 1);
    assert.strictEqual(parsed.suggestedBets[0].selection, 'Fast Horse');
  })();
}

/* ── 13. API handler — race detail endpoint ────────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '5', distance: '1400m', runners: [{ name: 'Thunder', runner_number: '2', odds: 5.0 }] }
      ]};
      return f;
    },
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/races/pukekohe/5', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/races/pukekohe/5');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.race.meeting, 'Pukekohe');
    assert.strictEqual(parsed.race.runners[0].name, 'Thunder');
  })();
}

/* ── 14. API handler — 404 for unknown routes ──────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/nonexistent', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/nonexistent');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 404);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'not_found');
  })();
}

/* ── 15. API handler — non-v1 routes are not handled ───────────────── */
{
  const handler = createApiHandler({
    getAuthState: () => ({ username: 'admin', password: 'pass', users: [], adminApiKeys: [] }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/health');
  const res = fakeRes();
  const url = new URL('http://localhost/api/health');
  (async () => {
    const handled = await handler(req, res, url);
    assert.strictEqual(handled, false, 'Non-v1 routes should not be handled');
  })();
}

/* ── 16. ask-betman POST endpoint ──────────────────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => {
      if (p.includes('races.json')) return { races: [
        { meeting: 'Pukekohe', race_number: '3', description: 'Maiden 1200m', runners: [{ name: 'Star', runner_number: '1' }] }
      ]};
      if (p.includes('status.json')) return {
        suggestedBets: [{ meeting: 'Pukekohe', race: '3', selection: 'Star', type: 'Win' }],
        marketMovers: [],
        interestingRunners: []
      };
      return f;
    },
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakePostReq('/api/v1/ask-betman', { question: 'Who should I bet on at Pukekohe Race 3?', meeting: 'pukekohe', race: '3' }, { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/ask-betman');

  (async () => {
    await handler(req, res, url);
    // wait for end event
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(res.statusCode, 200, 'ask-betman should return 200');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert(parsed.question, 'Should echo the question');
    assert(parsed.analysis, 'Should include analysis');
    assert(parsed.analysis.matchedRace, 'Should match the race');
    assert.strictEqual(parsed.analysis.matchedRace.meeting, 'Pukekohe');
  })();
}

/* ── 17. ask-betman validation ─────────────────────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  // Missing question
  const req = fakePostReq('/api/v1/ask-betman', {}, { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/ask-betman');
  (async () => {
    await handler(req, res, url);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(res.statusCode, 400, 'Missing question should return 400');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'missing_question');
  })();
}

/* ── 18. Constants exported correctly ──────────────────────────────── */
assert.strictEqual(typeof API_VERSION, 'string');
assert(API_VERSION.match(/^\d+\.\d+\.\d+$/), 'API_VERSION should be semver');
assert.strictEqual(typeof DEFAULT_RATE_LIMIT, 'number');
assert.strictEqual(typeof DEFAULT_RATE_WINDOW, 'number');
console.log('  ✓ Module constants exported correctly');

/* ── 19. API handler — /me endpoint ────────────────────────────────── */
{
  const testKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [],
      adminApiKeys: [{ key: testKey, label: 'Test', active: true }]
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => f,
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': testKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/me');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.user.username, 'admin');
    assert.strictEqual(parsed.user.isAdmin, true);
  })();
}

/* ── 20. API handler — user key access for regular user ────────────── */
{
  const userKey = generateApiKey();
  const handler = createApiHandler({
    getAuthState: () => ({
      username: 'admin',
      password: 'pass',
      users: [{
        username: 'punter@test.com',
        password: 'pass',
        role: 'user',
        tenantId: 'acct_punter',
        planType: 'single',
        apiKeys: [{ key: userKey, label: 'Punter Key', active: true }]
      }],
      adminApiKeys: []
    }),
    saveAuthState: () => {},
    loadJson: (p, f) => {
      if (p.includes('status.json')) return { suggestedBets: [], marketMovers: [], interestingRunners: [] };
      if (p.includes('races.json')) return { races: [] };
      return f;
    },
    resolveTenantPath: (req, dp) => dp,
    dataDir: DATA_DIR,
    rootDir: ROOT
  });

  const req = fakeReq('GET', '/api/v1/me', { 'x-api-key': userKey });
  const res = fakeRes();
  const url = new URL('http://localhost/api/v1/me');
  (async () => {
    await handler(req, res, url);
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.user.username, 'punter@test.com');
    assert.strictEqual(parsed.user.isAdmin, false);
    assert.strictEqual(parsed.user.planType, 'single');
  })();
}

// Let all async tests settle
setTimeout(() => {
  console.log('betman_api tests passed');
}, 200);
