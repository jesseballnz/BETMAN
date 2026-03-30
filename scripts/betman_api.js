#!/usr/bin/env node
/**
 * BETMAN Commercial API v1
 * --------------------------
 * Premium API endpoints for the BETMAN racing intelligence platform.
 * Provides AI-powered race analysis, suggested bets, market movers,
 * and (for admin accounts) direct TAB API proxy access.
 *
 * Authentication: API key via X-API-Key header or ?api_key query parameter,
 * or a trusted session principal injected by the frontend server.
 * Rate limiting: Configurable per-key sliding window.
 */
'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

/* ── Configuration ─────────────────────────────────────────────────── */
const API_VERSION = '1.0.0';
const DEFAULT_RATE_LIMIT   = Number(process.env.BETMAN_API_RATE_LIMIT   || 60);   // requests per window
const DEFAULT_RATE_WINDOW  = Number(process.env.BETMAN_API_RATE_WINDOW  || 60);   // window in seconds
const TAB_BASE = 'https://api.tab.co.nz/affiliates/v1';

/* ── API-key helpers ───────────────────────────────────────────────── */

function generateApiKey() {
  return `bm_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Resolve the API key from the request.
 * Checks X-API-Key header first, then ?api_key query parameter.
 */
function extractApiKey(req, url) {
  const header = String(req.headers['x-api-key'] || '').trim();
  if (header) return header;

  const auth = String(req.headers['authorization'] || '').trim();
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && bearerMatch[1]) return String(bearerMatch[1]).trim();

  if (url && url.searchParams) {
    const qp = String(url.searchParams.get('api_key') || '').trim();
    if (qp) return qp;
  }
  return null;
}

/* ── Rate limiter (sliding-window in-memory) ───────────────────────── */
const rateBuckets = new Map();

function rateCheck(key, limit, windowSec) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    rateBuckets.set(key, bucket);
  }
  // evict stale entries
  bucket.hits = bucket.hits.filter(ts => (now - ts) < windowMs);
  if (bucket.hits.length >= limit) {
    const oldestInWindow = bucket.hits[0] || now;
    const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
  bucket.hits.push(now);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfter: 0 };
}

// periodic cleanup (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - (DEFAULT_RATE_WINDOW * 1000 * 2);
  for (const [key, bucket] of rateBuckets) {
    bucket.hits = bucket.hits.filter(ts => ts > cutoff);
    if (bucket.hits.length === 0) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/* ── TAB API proxy helpers ─────────────────────────────────────────── */

async function tabFetch(endpoint, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const url = `${TAB_BASE}${endpoint}${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'betman-api/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, error: `tab_api_error`, status: resp.status, message: `TAB API returned ${resp.status}` };
    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'tab_api_unreachable', message: String(e.message || 'TAB API request failed') };
  }
}

/* ── JSON response helpers ─────────────────────────────────────────── */

function getCorsHeaders(req) {
  const origin = String(req?.headers?.origin || '').trim();
  const allowed = new Set(
    String(process.env.BETMAN_CORS_ORIGINS || 'http://localhost:8081,http://127.0.0.1:8081,http://localhost:8080,http://127.0.0.1:8080')
      .split(',')
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
  const allowOrigin = allowed.has(origin) ? origin : 'http://localhost:8081';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function apiJson(req, res, payload, code = 200, rateInfo) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...getCorsHeaders(req)
  };
  if (rateInfo) {
    headers['X-RateLimit-Limit'] = String(rateInfo.limit || DEFAULT_RATE_LIMIT);
    headers['X-RateLimit-Remaining'] = String(rateInfo.remaining ?? '');
    headers['X-RateLimit-Window'] = String(rateInfo.window || DEFAULT_RATE_WINDOW);
    if (rateInfo.retryAfter) headers['Retry-After'] = String(rateInfo.retryAfter);
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(payload, null, 2));
}

function apiError(req, res, code, error, message, rateInfo) {
  apiJson(req, res, { ok: false, error, message, api_version: API_VERSION }, code, rateInfo);
}

/* ── Route handler factory ─────────────────────────────────────────── */

/**
 * Mount the BETMAN API v1 onto the existing HTTP server.
 *
 * @param {object} deps - injected dependencies from frontend_server.js
 * @param {function} deps.getAuthState     - () => authState object
 * @param {function} deps.saveAuthState    - (nextState) => void
 * @param {function} deps.loadJson         - (filepath, fallback) => parsed JSON
 * @param {function} deps.resolveTenantPath - (req, defaultPath, filename) => resolved path
 * @param {function} deps.buildAiContextSummary - AI context builder
 * @param {string}   deps.dataDir          - path to frontend/data
 * @param {string}   deps.rootDir          - project root
 *
 * @returns {function} handler(req, res, url) => boolean  (true = handled)
 */
function createApiHandler(deps) {
  const {
    getAuthState,
    saveAuthState: persistAuthState,
    loadJson,
    resolveTenantPath,
    dataDir,
    rootDir,
    getSessionPrincipal,
    resolveTenantPathById
  } = deps;

  function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
  }

  /* ── API-key auth middleware ──────────────────────────────────────── */

  function findKeyRecord(apiKey) {
    if (!apiKey) return null;
    const state = getAuthState();

    const legacyAdminHash = String(state?.adminMeta?.apiKeyHash || '').trim();
    if (legacyAdminHash && sha256(apiKey) === legacyAdminHash) {
      return {
        keyRecord: {
          key: apiKey,
          label: 'legacy-admin-key',
          active: true,
          createdAt: state?.adminMeta?.apiKeyCreatedAt || null,
          keyPreview: state?.adminMeta?.apiKeyPreview || null,
          legacy: true
        },
        principal: {
          username: state.username,
          role: 'admin',
          isAdmin: true,
          tenantId: 'default',
          planType: 'admin',
          source: 'api_key_legacy_admin'
        }
      };
    }

    const allUsers = [
      { username: state.username, role: 'admin', isAdmin: true, tenantId: 'default', apiKeys: state.adminApiKeys || [] },
      ...(state.users || []).map(u => ({
        username: u.username,
        role: u.role || 'user',
        isAdmin: (u.role || 'user') === 'admin',
        tenantId: u.tenantId || 'default',
        planType: u.planType || 'single',
        apiKeys: u.apiKeys || []
      }))
    ];
    for (const user of allUsers) {
      const keys = user.apiKeys || [];
      const match = keys.find(k => k.key === apiKey && k.active !== false);
      if (match) {
        return {
          keyRecord: match,
          principal: {
            username: user.username,
            role: user.role,
            isAdmin: user.isAdmin,
            tenantId: user.tenantId,
            planType: user.planType || (user.isAdmin ? 'admin' : 'single'),
            source: 'api_key'
          }
        };
      }
    }
    return null;
  }

  function requireApiAuth(req, res, url) {
    const sessionPrincipal = typeof getSessionPrincipal === 'function' ? getSessionPrincipal(req) : null;
    if (sessionPrincipal) {
      req.apiPrincipal = {
        username: sessionPrincipal.username,
        role: sessionPrincipal.role || 'user',
        isAdmin: !!sessionPrincipal.isAdmin,
        tenantId: sessionPrincipal.tenantId || 'default',
        effectiveTenantId: sessionPrincipal.effectiveTenantId || sessionPrincipal.tenantId || 'default',
        planType: sessionPrincipal.planType || (sessionPrincipal.isAdmin ? 'admin' : 'single'),
        source: 'session'
      };
      req.apiRateInfo = null;
      return req.apiPrincipal;
    }

    const rawKey = extractApiKey(req, url);
    if (!rawKey) {
      apiError(req, res, 401, 'api_key_required', 'Provide an API key via X-API-Key header or api_key query parameter.');
      return null;
    }
    const record = findKeyRecord(rawKey);
    if (!record) {
      apiError(req, res, 401, 'invalid_api_key', 'The provided API key is invalid or has been revoked.');
      return null;
    }
    // rate limit
    const limit = record.keyRecord.rateLimit || DEFAULT_RATE_LIMIT;
    const window = record.keyRecord.rateWindow || DEFAULT_RATE_WINDOW;
    const check = rateCheck(rawKey, limit, window);
    const rateInfo = { limit, remaining: check.remaining, window, retryAfter: check.retryAfter };
    if (!check.allowed) {
      apiError(req, res, 429, 'rate_limit_exceeded', `Rate limit of ${limit} requests per ${window}s exceeded. Retry after ${check.retryAfter}s.`, rateInfo);
      return null;
    }
    req.apiPrincipal = record.principal;
    req.apiRateInfo = rateInfo;
    return record.principal;
  }

  /* ── Data readers ─────────────────────────────────────────────────── */

  function readDataFile(filename, fallback) {
    const p = path.join(dataDir, filename);
    return loadJson(p, fallback);
  }

  /* ── Route table ─────────────────────────────────────────────────── */

  /**
   * Returns true if the request was handled.
   */
  async function handle(req, res, url) {
    const p = url.pathname;

    // Only handle /api/v1/* routes
    if (!p.startsWith('/api/v1/')) return false;

    const route = p.slice(7); // strip '/api/v1'

    /* ── Public: version / health ─────────────────────────────────── */
    if (req.method === 'GET' && route === '/health') {
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        service: 'BETMAN Racing Intelligence API',
        timestamp: new Date().toISOString()
      }), true;
    }

    if (req.method === 'GET' && route === '/version') {
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        product: 'BETMAN',
        description: 'AI-Powered Horse Racing Intelligence',
        documentation: '/docs/API.md'
      }), true;
    }

    /* ── Authenticated routes ─────────────────────────────────────── */
    const principal = requireApiAuth(req, res, url);
    if (!principal) return true; // error already sent

    const rateInfo = req.apiRateInfo;

    /* ── GET /api/v1/me ───────────────────────────────────────────── */
    if (req.method === 'GET' && route === '/me') {
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        user: {
          username: principal.username,
          role: principal.role,
          isAdmin: !!principal.isAdmin,
          planType: principal.planType || 'single'
        }
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/models ─────────────────────────────────────── */
    if (req.method === 'GET' && route === '/models') {
      const defaultProvider = String(process.env.BETMAN_CHAT_PROVIDER || '').trim().toLowerCase()
        || ((process.env.OLLAMA_BASE_URL || process.env.BETMAN_OLLAMA_BASE_URL || process.env.BETMAN_CHAT_BASE_URL) ? 'ollama' : '')
        || ((process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY) ? 'openai' : '')
        || 'ollama';

      const ollamaFallbacks = ['qwen2.5:1.5b', 'llama3.2:3b', 'deepseek-r1:8b', 'llama3.1:8b'];
      const openaiModels = ['gpt-4o-mini', 'gpt-5.2'];
      const defaultModel = process.env.BETMAN_CHAT_MODEL
        || (defaultProvider === 'ollama' ? 'qwen2.5:1.5b' : 'gpt-4o-mini');

      // Attempt live Ollama tag fetch
      let ollamaModels = ollamaFallbacks;
      let ollamaLive = false;
      const ollamaBase = String(
        process.env.BETMAN_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL
        || process.env.BETMAN_CHAT_BASE_URL || ''
      ).replace(/\/+$/, '');
      if (ollamaBase) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const resp = await fetch(`${ollamaBase}/api/tags`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.models) && data.models.length) {
              ollamaModels = data.models.map(m => m.name || m.model).filter(Boolean);
              ollamaLive = true;
            }
          }
        } catch { /* live fetch optional */ }
      }

      const smallModels = new Set(['deepseek-r1:8b', 'llama3.1:8b', 'llama3.2:3b', 'qwen2.5:1.5b', 'qwen2.5:3b']);
      const allModels = [
        ...ollamaModels.map(m => ({
          id: m,
          name: m,
          label: m,
          provider: 'ollama',
          profile: smallModels.has(m) ? 'small' : 'large'
        })),
        ...openaiModels.map(m => ({
          id: m,
          name: m,
          label: m,
          provider: 'openai',
          profile: 'large'
        }))
      ];

      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        defaultProvider,
        defaultModel,
        ollamaLive,
        models: allModels
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/races ────────────────────────────────────────── */
    if (req.method === 'GET' && route === '/races') {
      const races = readDataFile('races.json', { races: [] });
      const list = Array.isArray(races.races) ? races.races : (Array.isArray(races) ? races : []);
      const country = String(url.searchParams.get('country') || '').toUpperCase();
      const meeting = String(url.searchParams.get('meeting') || '').toLowerCase();
      let filtered = list;
      if (country) {
        filtered = filtered.filter(r => String(r.country || '').toUpperCase() === country);
      }
      if (meeting) {
        filtered = filtered.filter(r => String(r.meeting || '').toLowerCase().includes(meeting));
      }
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        count: filtered.length,
        races: filtered.map(r => ({
          meeting: r.meeting,
          race_number: r.race_number || r.raceNumber,
          description: r.description || null,
          distance: r.distance || null,
          track_condition: r.track_condition || r.trackCondition || null,
          rail_position: r.rail_position || null,
          race_status: r.race_status || null,
          weather: r.weather || null,
          country: r.country || null,
          start_time: r.start_time || r.start_time_nz || r.startTime || null,
          runner_count: Array.isArray(r.runners) ? r.runners.length : 0
        }))
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/races/:meeting/:race ─────────────────────────── */
    const raceDetailMatch = route.match(/^\/races\/([^/]+)\/(\d+)$/);
    if (req.method === 'GET' && raceDetailMatch) {
      const meetingSlug = decodeURIComponent(raceDetailMatch[1]).toLowerCase();
      const raceNum = raceDetailMatch[2];
      const races = readDataFile('races.json', { races: [] });
      const list = Array.isArray(races.races) ? races.races : (Array.isArray(races) ? races : []);
      const race = list.find(r =>
        String(r.meeting || '').toLowerCase().includes(meetingSlug) &&
        String(r.race_number || r.raceNumber || '') === raceNum
      );
      if (!race) {
        return apiError(req, res, 404, 'race_not_found', `No race found for meeting "${meetingSlug}" race ${raceNum}.`, rateInfo), true;
      }
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        race: {
          meeting: race.meeting,
          race_number: race.race_number || race.raceNumber,
          description: race.description || null,
          distance: race.distance || null,
          track_condition: race.track_condition || race.trackCondition || null,
          rail_position: race.rail_position || null,
          race_status: race.race_status || null,
          weather: race.weather || null,
          country: race.country || null,
          start_time: race.start_time || race.start_time_nz || race.startTime || null,
          runners: (race.runners || []).map(r => ({
            number: r.runner_number || r.number,
            name: r.name || r.runner_name,
            barrier: r.barrier || null,
            jockey: r.jockey || null,
            trainer: r.trainer || null,
            trainerLocation: r.trainer_location || null,
            apprentice: r.apprentice_indicator || null,
            weight: r.weight || r.weight_total || null,
            age: r.age || null,
            sex: r.sex || null,
            gear: r.gear || null,
            form: r.last_twenty_starts || r.form || null,
            lastStarts: r.last_starts || null,
            formComment: r.form_comment || null,
            formIndicators: r.form_indicators || null,
            speedmap: r.speedmap || null,
            odds: r.odds || r.fixed_win || null,
            fixedWin: r.fixed_win || null,
            fixedPlace: r.fixed_place || null,
            sire: r.sire || null,
            dam: r.dam || null,
            damSire: r.dam_sire || null,
            stats: r.stats || null
          }))
        }
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/suggested-bets ───────────────────────────────── */
    if (req.method === 'GET' && route === '/suggested-bets') {
      const status = readDataFile('status.json', {});
      const bets = status.suggestedBets || [];
      const meeting = String(url.searchParams.get('meeting') || '').toLowerCase();
      const raceParam = String(url.searchParams.get('race') || '').replace(/^R/i, '').trim();
      let filtered = bets;
      if (meeting) {
        filtered = filtered.filter(b => String(b.meeting || '').toLowerCase().includes(meeting));
      }
      if (raceParam) {
        filtered = filtered.filter(b => String(b.race || '').replace(/^R/i, '').trim() === raceParam);
      }

      const exoticTypes = new Set(['multi', 'top2', 'top3', 'top4', 'trifecta']);
      const formatBet = (b) => ({
        meeting: b.meeting,
        race: b.race,
        selection: b.selection,
        type: b.type || 'Win',
        aiWinProb: b.aiWinProb || null,
        signalScore: b.signal_score || null,
        stake: b.stake || null,
        odds: b.odds || null,
        placeOdds: b.place_odds || null,
        jumpsIn: b.jumpsIn || null,
        reason: b.reason || null,
        tags: b.tags || [],
        pedigreeTag: b.pedigreeTag || null,
        interesting: b.interesting || false
      });

      const wins = filtered.filter(b => !exoticTypes.has(String(b.type || '').toLowerCase())).map(formatBet);
      const exotics = filtered.filter(b => exoticTypes.has(String(b.type || '').toLowerCase())).map(formatBet);

      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        count: filtered.length,
        updatedAt: status.updatedAt || null,
        wins,
        exotics,
        all: filtered.map(formatBet)
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/interesting-runners ──────────────────────────── */
    if (req.method === 'GET' && route === '/interesting-runners') {
      const status = readDataFile('status.json', {});
      const runners = status.interestingRunners || [];
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        count: runners.length,
        interestingRunners: runners.map(r => ({
          meeting: r.meeting,
          race: r.race,
          runner: r.runner || r.selection,
          reason: r.reason || null,
          odds: r.odds || null,
          probability: r.aiWinProb || r.probability || null,
          eta: r.eta || null
        }))
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/market-movers ────────────────────────────────── */
    if (req.method === 'GET' && route === '/market-movers') {
      const status = readDataFile('status.json', {});
      const movers = status.marketMovers || [];
      const meeting = String(url.searchParams.get('meeting') || '').toLowerCase();
      let filtered = movers;
      if (meeting) {
        filtered = filtered.filter(m => String(m.meeting || '').toLowerCase().includes(meeting));
      }
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        count: filtered.length,
        marketMovers: filtered.map(m => ({
          meeting: m.meeting,
          race: m.race,
          runner: m.runner || m.selection || m.name,
          previousOdds: m.previousOdds || m.prevOdds || m.fromOdds || null,
          currentOdds: m.currentOdds || m.odds || m.toOdds || null,
          direction: m.direction || null,
          magnitude: m.magnitude || m.pctMove || null,
          pctSource: m.pctSource || null
        }))
      }, 200, rateInfo), true;
    }

    /* ── GET/POST /api/v1/tracked-bets ───────────────────────────── */
    if (route === '/tracked-bets') {
      const tenantId = principal.effectiveTenantId || principal.tenantId || 'default';
      const trackedPath = resolveTenantPathById
        ? resolveTenantPathById(tenantId, path.join(rootDir, 'frontend', 'data', 'tracked_bets.json'), 'tracked_bets.json')
        : path.join(rootDir, 'frontend', 'data', 'tracked_bets.json');
      const settledPath = resolveTenantPathById
        ? resolveTenantPathById(tenantId, path.join(rootDir, 'frontend', 'data', 'settled_bets.json'), 'settled_bets.json')
        : path.join(rootDir, 'frontend', 'data', 'settled_bets.json');
      const trackedRows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
      const settledRows = Array.isArray(loadJson(settledPath, [])) ? loadJson(settledPath, []) : [];
      const normalize = (s) => String(s || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
      const mine = trackedRows.filter((row) => normalize(row.username) === normalize(principal.username));
      const resolved = mine.map((row) => {
        const hit = settledRows.find((s) =>
          normalize(s.meeting) === normalize(row.meeting) &&
          String(s.race || '').replace(/^R/i, '') === String(row.race || '').replace(/^R/i, '') &&
          normalize(s.selection) === normalize(row.selection) &&
          normalize(s.type) === normalize(row.betType)
        );
        if (!hit) return row;
        return {
          ...row,
          status: 'settled',
          result: String(hit.result || 'pending').toLowerCase(),
          settledAt: hit.settledAt || row.settledAt || null,
          payout: hit.payout ?? row.payout ?? null,
        };
      });

      if (req.method === 'GET') {
        return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBets: resolved }, 200, rateInfo), true;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload = {};
          try { payload = body ? JSON.parse(body) : {}; } catch {}
          const next = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
            username: principal.username,
            meeting: payload.meeting,
            race: String(payload.race || ''),
            selection: payload.selection,
            betType: payload.betType || payload.type || 'Win',
            odds: payload.odds ?? null,
            source: payload.source || 'manual',
            trackedAt: new Date().toISOString(),
            status: 'active',
            result: 'pending',
            settledAt: null,
          };
          if (!next.meeting || !next.race || !next.selection) return apiError(req, res, 400, 'invalid_payload', 'meeting, race, and selection are required.', rateInfo);
          fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
          fs.writeFileSync(trackedPath, JSON.stringify([next, ...trackedRows], null, 2));
          return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBet: next }, 200, rateInfo);
        });
        return true;
      }
    }

    if (route.startsWith('/tracked-bets/')) {
      const tenantId = principal.effectiveTenantId || principal.tenantId || 'default';
      const trackedPath = resolveTenantPathById
        ? resolveTenantPathById(tenantId, path.join(rootDir, 'frontend', 'data', 'tracked_bets.json'), 'tracked_bets.json')
        : path.join(rootDir, 'frontend', 'data', 'tracked_bets.json');
      const trackedRows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
      const trackedId = decodeURIComponent(route.split('/').pop() || '');
      const normalize = (s) => String(s || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();

      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload = {};
          try { payload = body ? JSON.parse(body) : {}; } catch {}
          const updated = trackedRows.map((row) => {
            if (String(row.id) !== trackedId) return row;
            if (!principal.isAdmin && normalize(row.username) !== normalize(principal.username)) return row;
            return { ...row, ...payload, id: row.id, username: row.username };
          });
          fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
          fs.writeFileSync(trackedPath, JSON.stringify(updated, null, 2));
          return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBet: updated.find((r) => String(r.id) === trackedId) || null }, 200, rateInfo);
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const updated = trackedRows.filter((row) => !(String(row.id) === trackedId && (principal.isAdmin || normalize(row.username) === normalize(principal.username))));
        fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
        fs.writeFileSync(trackedPath, JSON.stringify(updated, null, 2));
        return apiJson(req, res, { ok: true, api_version: API_VERSION }, 200, rateInfo), true;
      }
    }

    /* ── GET/POST /api/v1/heatmap + detail placeholders ───────────── */
    if (req.method === 'GET' && route === '/heatmap') {
      const data = readDataFile('heatmap_observations.json', { observations: [] });
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        automationReady: true,
        observations: Array.isArray(data.observations) ? data.observations : []
      }, 200, rateInfo), true;
    }

    if (req.method === 'POST' && route === '/heatmap/intake') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const existing = readDataFile('heatmap_observations.json', { observations: [] });
        const observation = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
          meeting: payload.meeting || null,
          race: payload.race || null,
          horseNumber: payload.horseNumber || payload.saddleClothRead || null,
          runnerName: payload.runnerName || null,
          capturedAt: payload.capturedAt || new Date().toISOString(),
          sourceDevice: payload.sourceDevice || null,
          saddleClothRead: payload.saddleClothRead || null,
          imageRefs: Array.isArray(payload.imageRefs) ? payload.imageRefs : [],
          infraredImageCount: Array.isArray(payload.imageRefs) ? payload.imageRefs.length : Number(payload.infraredImageCount || 0),
          status: 'pending',
          heatScore: null,
          riskLevel: null,
          zones: [],
          notes: payload.notes || null,
          metadata: payload.metadata || {}
        };
        const next = {
          observations: [observation, ...((Array.isArray(existing.observations) ? existing.observations : []))]
        };
        fs.writeFileSync(path.join(dataDir, 'heatmap_observations.json'), JSON.stringify(next, null, 2));
        return apiJson(req, res, { ok: true, api_version: API_VERSION, observation }, 200, rateInfo);
      });
      return true;
    }

    if (req.method === 'GET' && route.startsWith('/heatmap/')) {
      const parts = route.split('/').filter(Boolean);
      const data = readDataFile('heatmap_observations.json', { observations: [] });
      const rows = Array.isArray(data.observations) ? data.observations : [];
      if (parts.length >= 3) {
        const [, meeting, race] = parts;
        const horseNumber = parts[3] || null;
        const filtered = rows.filter((r) => String(r.meeting || '').toLowerCase() === decodeURIComponent(meeting).toLowerCase() && String(r.race || '') === decodeURIComponent(race) && (!horseNumber || String(r.horseNumber || '') === decodeURIComponent(horseNumber)));
        return apiJson(req, res, { ok: true, api_version: API_VERSION, observations: filtered, automationReady: true }, 200, rateInfo), true;
      }
    }

    /* ── GET /api/v1/alerts-feed ───────────────────────────────────── */
    if (req.method === 'GET' && route === '/alerts-feed') {
      const data = readDataFile('alerts_feed.json', { updatedAt: null, alerts: [] });
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        updatedAt: data.updatedAt || null,
        alerts: Array.isArray(data.alerts) ? data.alerts : []
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/alerts-history ────────────────────────────────── */
    if (req.method === 'GET' && route === '/alerts-history') {
      const data = readDataFile('alerts_history.json', []);
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        alerts: Array.isArray(data) ? data : []
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/learnings-report ──────────────────────────────── */
    if (req.method === 'GET' && route === '/learnings-report') {
      const data = readDataFile('learnings_report.json', {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        ...data
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/status ───────────────────────────────────────── */
    if (req.method === 'GET' && route === '/status') {
      const status = readDataFile('status.json', {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        updatedAt: status.updatedAt || null,
        balance: status.balance ?? null,
        openBets: status.openBets ?? 0,
        feelMeter: status.feelMeter || null,
        upcomingRaceCount: Array.isArray(status.upcomingRaces) ? status.upcomingRaces.length : 0,
        suggestedBetCount: Array.isArray(status.suggestedBets) ? status.suggestedBets.length : 0
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/performance ──────────────────────────────────── */
    if (req.method === 'GET' && route === '/performance') {
      const period = String(url.searchParams.get('period') || 'daily').toLowerCase();
      const validPeriods = ['daily', 'weekly', 'monthly'];
      if (!validPeriods.includes(period)) {
        return apiError(req, res, 400, 'invalid_period', `Period must be one of: ${validPeriods.join(', ')}`, rateInfo), true;
      }
      const fileMap = { daily: 'success_daily.json', weekly: 'success_weekly.json', monthly: 'success_monthly.json' };
      const data = readDataFile(fileMap[period], {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        period,
        data
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/stake-config ─────────────────────────────────── */
    if (req.method === 'GET' && route === '/stake-config') {
      const stake = readDataFile('stake.json', {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        stakePerRace: stake.stakePerRace || null,
        exoticStakePerRace: stake.exoticStakePerRace || null,
        earlyWindowMin: stake.earlyWindowMin || null,
        aiWindowMin: stake.aiWindowMin || null,
        betHarderMultiplier: stake.betHarderMultiplier || null
      }, 200, rateInfo), true;
    }

    /* ── POST /api/v1/ask-betman ──────────────────────────────────── */
    if (req.method === 'POST' && route === '/ask-betman') {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload;
          try { payload = body ? JSON.parse(body) : {}; } catch {
            apiError(req, res, 400, 'invalid_json', 'Request body must be valid JSON.', rateInfo);
            return resolve(true);
          }
          const question = String(payload.question || '').trim();
          if (!question) {
            apiError(req, res, 400, 'missing_question', 'The "question" field is required.', rateInfo);
            return resolve(true);
          }
          if (question.length > 2000) {
            apiError(req, res, 400, 'question_too_long', 'Questions are limited to 2000 characters.', rateInfo);
            return resolve(true);
          }

          // Build context from available data
          const races = readDataFile('races.json', { races: [] });
          const status = readDataFile('status.json', {});
          const raceList = Array.isArray(races.races) ? races.races : (Array.isArray(races) ? races : []);

          // Try to match question to a specific race via explicit hints
          const meetingHint = String(payload.meeting || '').trim().toLowerCase();
          const raceHint = String(payload.race || '').trim();

          let matchedRace = null;
          if (meetingHint && raceHint) {
            matchedRace = raceList.find(r =>
              String(r.meeting || '').toLowerCase().includes(meetingHint) &&
              String(r.race_number || r.raceNumber || '') === raceHint
            );
          }

          // Venue-aware temporal race detection from the question text
          if (!matchedRace) {
            const q = question.toLowerCase();
            const finishedStatuses = new Set(['final', 'closed', 'abandoned', 'resulted']);
            // Detect venue from question
            const availableMeetings = [...new Set(raceList.map(r => String(r.meeting || '').trim()).filter(Boolean))];
            let detectedMeeting = meetingHint
              ? availableMeetings.find(m => m.toLowerCase().includes(meetingHint))
              : availableMeetings.find(m => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q));

            if (detectedMeeting) {
              const venueRaces = raceList.filter(r =>
                String(r.meeting || '').trim().toLowerCase() === detectedMeeting.toLowerCase()
              );
              const wantsLast = /\b(last|previous|latest|most recent|just ran|just run)\b/i.test(q);
              const wantsNext = /\b(next|upcoming|coming up)\b/i.test(q);

              if (wantsLast) {
                // Pick the most recently finished race
                const finished = venueRaces
                  .filter(r => finishedStatuses.has(String(r.race_status || '').toLowerCase()))
                  .sort((a, b) => (Number(b.race_number) || 0) - (Number(a.race_number) || 0));
                if (finished.length) matchedRace = finished[0];
              } else if (wantsNext) {
                // Pick the next upcoming race
                const upcoming = venueRaces
                  .filter(r => !finishedStatuses.has(String(r.race_status || '').toLowerCase()))
                  .sort((a, b) => (Number(a.race_number) || 0) - (Number(b.race_number) || 0));
                if (upcoming.length) matchedRace = upcoming[0];
              }
              // If still no match but venue was mentioned, pick the first open race
              if (!matchedRace && venueRaces.length) {
                const open = venueRaces
                  .filter(r => !finishedStatuses.has(String(r.race_status || '').toLowerCase()))
                  .sort((a, b) => (Number(a.race_number) || 0) - (Number(b.race_number) || 0));
                if (open.length) matchedRace = open[0];
              }
            }
          }

          const formatRunner = (r) => ({
            number: r.runner_number || r.number,
            name: r.name || r.runner_name,
            barrier: r.barrier || null,
            jockey: r.jockey || null,
            trainer: r.trainer || null,
            trainerLocation: r.trainer_location || null,
            apprentice: r.apprentice_indicator || null,
            weight: r.weight || r.weight_total || null,
            age: r.age || null,
            sex: r.sex || null,
            gear: r.gear || null,
            form: r.last_twenty_starts || r.form || null,
            lastStarts: r.last_starts || null,
            formComment: r.form_comment || null,
            formIndicators: r.form_indicators || null,
            speedmap: r.speedmap || null,
            odds: r.odds || r.fixed_win || null,
            sire: r.sire || null,
            dam: r.dam || null,
            damSire: r.dam_sire || null,
            stats: r.stats || null
          });

          // Construct an informational answer using available data
          const suggestedBets = status.suggestedBets || [];
          const marketMovers = status.marketMovers || [];
          const interestingRunners = status.interestingRunners || [];

          const context = {
            racesAvailable: raceList.length,
            suggestedBetCount: suggestedBets.length,
            marketMoverCount: marketMovers.length,
            matchedRace: matchedRace ? {
              meeting: matchedRace.meeting,
              race: matchedRace.race_number || matchedRace.raceNumber,
              distance: matchedRace.distance || null,
              runners: (matchedRace.runners || []).length,
              trackCondition: matchedRace.track_condition || matchedRace.trackCondition || null,
              railPosition: matchedRace.rail_position || null,
              raceStatus: matchedRace.race_status || null
            } : null
          };

          // Find relevant suggested bets (scoped to matched race when available)
          let relevantBets = suggestedBets;
          const scopeMeeting = matchedRace
            ? String(matchedRace.meeting || '').toLowerCase()
            : (meetingHint || '');
          if (scopeMeeting) {
            const meetingBets = suggestedBets.filter(b => String(b.meeting || '').toLowerCase().includes(scopeMeeting));
            if (meetingBets.length > 0) {
              relevantBets = meetingBets;
              // Further scope to matched race number if available
              if (matchedRace) {
                const raceNum = String(matchedRace.race_number || matchedRace.raceNumber || '');
                const raceBets = relevantBets.filter(b => String(b.race || '').replace(/^R/i, '').trim() === raceNum);
                if (raceBets.length > 0) relevantBets = raceBets;
              }
            }
          }

          // Build response
          const response = {
            ok: true,
            api_version: API_VERSION,
            question,
            context,
            analysis: {
              matchedRace: matchedRace ? {
                meeting: matchedRace.meeting,
                raceNumber: matchedRace.race_number || matchedRace.raceNumber,
                description: matchedRace.description || null,
                distance: matchedRace.distance || null,
                trackCondition: matchedRace.track_condition || matchedRace.trackCondition || null,
                railPosition: matchedRace.rail_position || null,
                runners: (matchedRace.runners || []).map(formatRunner)
              } : null,
              suggestedBets: relevantBets.slice(0, 10).map(b => ({
                meeting: b.meeting,
                race: b.race,
                selection: b.selection,
                type: b.type || 'Win',
                aiWinProb: b.aiWinProb || null,
                stake: b.stake || null
              })),
              marketMovers: (scopeMeeting
                ? marketMovers.filter(m => String(m.meeting || '').toLowerCase().includes(scopeMeeting))
                : marketMovers
              ).slice(0, 10).map(m => ({
                meeting: m.meeting,
                race: m.race,
                runner: m.runner || m.selection || m.name,
                previousOdds: m.previousOdds || m.prevOdds || m.fromOdds || null,
                currentOdds: m.currentOdds || m.odds || m.toOdds || null,
                direction: m.direction || (Number(m.pctMove) < 0 ? 'firmed' : 'drifted') || null,
                magnitude: m.magnitude || m.pctMove || null
              })),
              interestingRunners: (scopeMeeting
                ? interestingRunners.filter(r => String(r.meeting || '').toLowerCase().includes(scopeMeeting))
                : interestingRunners
              ).slice(0, 10).map(r => ({
                meeting: r.meeting,
                race: r.race,
                runner: r.runner || r.selection,
                reason: r.reason || null,
                odds: r.odds || null,
                probability: r.aiWinProb || r.probability || null
              }))
            }
          };

          apiJson(req, res, response, 200, rateInfo);
          resolve(true);
        });
      });
    }

    /* ── GET /api/v1/bet-history ──────────────────────────────────── */
    if (req.method === 'GET' && route === '/bet-history') {
      const results = readDataFile('bet_results.json', []);
      const placed = readDataFile('placed_bets.json', []);
      const settled = readDataFile('settled_bets.json', []);
      const limitParam = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        placedBets: (Array.isArray(placed) ? placed : []).slice(-limitParam),
        betResults: (Array.isArray(results) ? results : []).slice(-limitParam),
        settledBets: (Array.isArray(settled) ? settled : []).slice(-limitParam)
      }, 200, rateInfo), true;
    }

    /* ── Admin-only: TAB API Proxy ────────────────────────────────── */

    if (route.startsWith('/tab/')) {
      if (!principal.isAdmin) {
        return apiError(req, res, 403, 'admin_required', 'TAB API proxy endpoints are restricted to admin accounts.', rateInfo), true;
      }

      /* GET /api/v1/tab/meetings */
      if (req.method === 'GET' && route === '/tab/meetings') {
        const date = String(url.searchParams.get('date') || 'today');
        const country = String(url.searchParams.get('country') || 'NZ').toUpperCase();
        const type = String(url.searchParams.get('type') || 'T');
        const limit = String(url.searchParams.get('limit') || '200');
        const offset = String(url.searchParams.get('offset') || '0');
        const result = await tabFetch('/racing/meetings', {
          date_from: date, date_to: date, country, type, limit, offset
        });
        if (!result.ok) return apiError(req, res, 502, result.error, result.message, rateInfo), true;
        return apiJson(req, res, {
          ok: true,
          api_version: API_VERSION,
          source: 'tab_nz_affiliates',
          params: { date, country, type },
          data: result.data
        }, 200, rateInfo), true;
      }

      /* GET /api/v1/tab/events/:id */
      const eventMatch = route.match(/^\/tab\/events\/([^/]+)$/);
      if (req.method === 'GET' && eventMatch) {
        const eventId = decodeURIComponent(eventMatch[1]);
        const result = await tabFetch(`/racing/events/${encodeURIComponent(eventId)}`, {
          with_money_tracker: 'true',
          with_big_bets: 'true',
          with_biggest_bet: 'true',
          with_tote_trends_data: 'true',
          present_overlay: 'false'
        });
        if (!result.ok) return apiError(req, res, 502, result.error, result.message, rateInfo), true;
        return apiJson(req, res, {
          ok: true,
          api_version: API_VERSION,
          source: 'tab_nz_affiliates',
          eventId,
          data: result.data
        }, 200, rateInfo), true;
      }

      /* GET /api/v1/tab/races */
      if (req.method === 'GET' && route === '/tab/races') {
        const channel = String(url.searchParams.get('channel') || 'Trackside1');
        const date = String(url.searchParams.get('date') || 'today');
        const type = String(url.searchParams.get('type') || 'T');
        const result = await tabFetch('/racing/races', { channel, type, date });
        if (!result.ok) return apiError(req, res, 502, result.error, result.message, rateInfo), true;
        return apiJson(req, res, {
          ok: true,
          api_version: API_VERSION,
          source: 'tab_nz_affiliates',
          params: { channel, date, type },
          data: result.data
        }, 200, rateInfo), true;
      }

      return apiError(req, res, 404, 'not_found', `TAB API endpoint not found: ${route}`, rateInfo), true;
    }

    /* ── Admin: API key management ────────────────────────────────── */

    /* GET /api/v1/keys — list API keys for the current user (admin sees all) */
    if (req.method === 'GET' && route === '/keys') {
      const state = getAuthState();
      if (principal.isAdmin) {
        const allKeys = [];
        (state.adminApiKeys || []).forEach(k => {
          allKeys.push({ username: state.username, role: 'admin', label: k.label || null, keyPrefix: k.key.slice(0, 10) + '…', active: k.active !== false, createdAt: k.createdAt || null });
        });
        (state.users || []).forEach(u => {
          (u.apiKeys || []).forEach(k => {
            allKeys.push({ username: u.username, role: u.role || 'user', label: k.label || null, keyPrefix: k.key.slice(0, 10) + '…', active: k.active !== false, createdAt: k.createdAt || null });
          });
        });
        return apiJson(req, res, { ok: true, api_version: API_VERSION, keys: allKeys }, 200, rateInfo), true;
      } else {
        const userRec = (state.users || []).find(u => u.username === principal.username);
        const keys = (userRec?.apiKeys || []).map(k => ({
          label: k.label || null,
          keyPrefix: k.key.slice(0, 10) + '…',
          active: k.active !== false,
          createdAt: k.createdAt || null
        }));
        return apiJson(req, res, { ok: true, api_version: API_VERSION, keys }, 200, rateInfo), true;
      }
    }

    /* POST /api/v1/keys — create new API key (admin can create for any user) */
    if (req.method === 'POST' && route === '/keys') {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload;
          try { payload = body ? JSON.parse(body) : {}; } catch {
            apiError(req, res, 400, 'invalid_json', 'Request body must be valid JSON.', rateInfo);
            return resolve(true);
          }
          const label = String(payload.label || 'API Key').trim().slice(0, 100);
          const targetUser = principal.isAdmin ? String(payload.username || principal.username).trim() : principal.username;
          const rateLimit = principal.isAdmin ? (Number(payload.rateLimit) || DEFAULT_RATE_LIMIT) : DEFAULT_RATE_LIMIT;
          const rateWindow = principal.isAdmin ? (Number(payload.rateWindow) || DEFAULT_RATE_WINDOW) : DEFAULT_RATE_WINDOW;

          const newKey = {
            key: generateApiKey(),
            label,
            rateLimit,
            rateWindow,
            active: true,
            createdAt: new Date().toISOString()
          };

          const state = getAuthState();
          const isAdminUser = targetUser === state.username;

          if (isAdminUser) {
            if (!principal.isAdmin) {
              apiError(req, res, 403, 'forbidden', 'Cannot create keys for admin account.', rateInfo);
              return resolve(true);
            }
            const adminKeys = state.adminApiKeys || [];
            adminKeys.push(newKey);
            persistAuthState({ ...state, adminApiKeys: adminKeys });
          } else {
            const users = [...(state.users || [])];
            const idx = users.findIndex(u => u.username === targetUser);
            if (idx < 0) {
              apiError(req, res, 404, 'user_not_found', `User "${targetUser}" not found.`, rateInfo);
              return resolve(true);
            }
            const userKeys = users[idx].apiKeys || [];
            userKeys.push(newKey);
            users[idx] = { ...users[idx], apiKeys: userKeys };
            persistAuthState({ ...state, users });
          }

          apiJson(req, res, {
            ok: true,
            api_version: API_VERSION,
            message: 'API key created. Store the key securely — it cannot be retrieved again.',
            key: newKey.key,
            label: newKey.label,
            username: targetUser,
            rateLimit: newKey.rateLimit,
            rateWindow: newKey.rateWindow,
            createdAt: newKey.createdAt
          }, 201, rateInfo);
          resolve(true);
        });
      });
    }

    /* DELETE /api/v1/keys — revoke an API key */
    if (req.method === 'DELETE' && route === '/keys') {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload;
          try { payload = body ? JSON.parse(body) : {}; } catch {
            apiError(req, res, 400, 'invalid_json', 'Request body must be valid JSON.', rateInfo);
            return resolve(true);
          }
          const keyPrefix = String(payload.keyPrefix || '').trim();
          const keyFull = String(payload.key || '').trim();

          if (!keyPrefix && !keyFull) {
            apiError(req, res, 400, 'missing_key', 'Provide "key" (full key) or "keyPrefix" to identify the key to revoke.', rateInfo);
            return resolve(true);
          }

          const state = getAuthState();
          let found = false;

          function matchKey(k) {
            if (keyFull && k.key === keyFull) return true;
            if (keyPrefix && k.key.startsWith(keyPrefix)) return true;
            return false;
          }

          // Check admin keys
          if (principal.isAdmin && state.adminApiKeys) {
            const idx = state.adminApiKeys.findIndex(matchKey);
            if (idx >= 0) {
              state.adminApiKeys[idx].active = false;
              state.adminApiKeys[idx].revokedAt = new Date().toISOString();
              persistAuthState(state);
              found = true;
            }
          }

          // Check user keys
          if (!found) {
            const users = [...(state.users || [])];
            for (let i = 0; i < users.length; i++) {
              const userKeys = users[i].apiKeys || [];
              const kidx = userKeys.findIndex(matchKey);
              if (kidx >= 0) {
                if (!principal.isAdmin && users[i].username !== principal.username) {
                  apiError(req, res, 403, 'forbidden', 'You can only revoke your own API keys.', rateInfo);
                  return resolve(true);
                }
                userKeys[kidx].active = false;
                userKeys[kidx].revokedAt = new Date().toISOString();
                users[i] = { ...users[i], apiKeys: userKeys };
                persistAuthState({ ...state, users });
                found = true;
                break;
              }
            }
          }

          if (!found) {
            apiError(req, res, 404, 'key_not_found', 'No matching active API key found.', rateInfo);
            return resolve(true);
          }

          apiJson(req, res, { ok: true, api_version: API_VERSION, message: 'API key revoked.' }, 200, rateInfo);
          resolve(true);
        });
      });
    }

    /* ── 404 for unmatched /api/v1/* routes ────────────────────────── */
    return apiError(req, res, 404, 'not_found', `Endpoint not found: ${req.method} ${p}`, rateInfo), true;
  }

  return handle;
}

/* ── Exports ───────────────────────────────────────────────────────── */
module.exports = {
  createApiHandler,
  generateApiKey,
  extractApiKey,
  rateCheck,
  apiJson,
  apiError,
  API_VERSION,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW
};
