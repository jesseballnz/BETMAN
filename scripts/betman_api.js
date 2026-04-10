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
const { buildRaceResultIndex, resolveTrackedBet, buildTrackedHistoryRows } = require('./tracked_bet_matching');
const { prunePulseTargetingAgainstRaces } = require('./pulse_targeting_semantics');

/* ── Configuration ─────────────────────────────────────────────────── */
const API_VERSION = '1.0.0';
const DEFAULT_RATE_LIMIT   = Number(process.env.BETMAN_API_RATE_LIMIT   || 60);   // requests per window
const DEFAULT_RATE_WINDOW  = Number(process.env.BETMAN_API_RATE_WINDOW  || 60);   // window in seconds
const API_KEY_PREFIX_LENGTH = Number(process.env.BETMAN_API_KEY_PREFIX_LEN || 10);
const API_KEY_PREVIEW_LENGTH = Number(process.env.BETMAN_API_KEY_PREVIEW_LEN || 6);
const TAB_BASE = 'https://api.tab.co.nz/affiliates/v1';
const PULSE_CONFIG_FILE = 'pulse_config.json';
const DEFAULT_PULSE_CONFIG = Object.freeze({
  enabled: true,
  alertTypes: {
    plunges: true,
    drifts: true,
    conflicts: true,
    selectionFlips: true,
    preJumpHeat: true,
    jumpPulse: true,
  },
  thresholds: {
    minSeverity: 'HOT',
    maxMinsToJump: null,
    minMovePct: null,
    trackedRunnerOverride: true,
  },
  targeting: {
    mode: 'all',
    countries: [],
    meetings: [],
    races: [],
  },
  updatedAt: null,
  updatedBy: null,
});
const FINISHED_RACE_STATUSES = new Set(['final', 'closed', 'finalized', 'abandoned', 'resulted', 'settled', 'complete', 'completed']);

function normalizeMeetingName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRaceValue(value) {
  return String(value || '').trim().replace(/^R/i, '');
}

function buildRaceMapFromPayload(payload) {
  const rows = Array.isArray(payload?.races) ? payload.races : (Array.isArray(payload) ? payload : []);
  const raceMap = new Map();
  rows.forEach((race) => {
    const key = `${normalizeMeetingName(race?.meeting)}|${normalizeRaceValue(race?.race_number || race?.race)}`;
    if (key !== '|') raceMap.set(key, race);
  });
  return raceMap;
}

function resolveTrackedRaceJumpMeta(row, race) {
  const rawStart = race?.start_time_nz || race?.start_time || race?.advertised_start || race?.jump_time || null;
  const parsedStartMs = rawStart ? Date.parse(String(rawStart)) : NaN;
  const raceMins = Number(race?.minsToJump ?? race?.mins_to_jump ?? race?.minutes_to_jump);
  const fallbackMins = Number(row?.minsToJump ?? row?.mins_to_jump);
  const minsToJump = Number.isFinite(raceMins)
    ? raceMins
    : (Number.isFinite(parsedStartMs)
      ? Math.round((parsedStartMs - Date.now()) / 60000)
      : (Number.isFinite(fallbackMins) ? fallbackMins : null));

  let jumpsIn = row?.jumpsIn ?? null;
  if (Number.isFinite(minsToJump)) {
    if (minsToJump <= 0) {
      jumpsIn = 'Jumped';
    } else if (minsToJump >= 120) {
      const hrs = Math.floor(minsToJump / 60);
      const mins = minsToJump % 60;
      jumpsIn = `in ${hrs}h ${mins}m`;
    } else {
      jumpsIn = `in ${minsToJump}m`;
    }
  }

  return {
    raceStartTime: rawStart || row?.raceStartTime || null,
    minsToJump: Number.isFinite(minsToJump) ? minsToJump : null,
    jumpsIn,
  };
}

function isLiveRaceEntry(entry, raceMap) {
  if (!(raceMap instanceof Map) || raceMap.size === 0) return true;
  const key = `${normalizeMeetingName(entry?.meeting)}|${normalizeRaceValue(entry?.race || entry?.race_number)}`;
  if (key === '|') return true;
  const race = raceMap.get(key);
  if (!race) return true;
  return !FINISHED_RACE_STATUSES.has(String(race?.race_status || '').trim().toLowerCase());
}

/* ── API-key helpers ───────────────────────────────────────────────── */

function generateApiKey() {
  return `bm_${crypto.randomBytes(24).toString('hex')}`;
}

function hashApiKeySecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

function deriveApiKeyPrefix(secret) {
  const normalized = String(secret || '').trim();
  if (!normalized) return null;
  return normalized.slice(0, API_KEY_PREFIX_LENGTH) || null;
}

function deriveApiKeyPreview(secret) {
  const normalized = String(secret || '').trim();
  if (!normalized) return null;
  if (normalized.length <= API_KEY_PREVIEW_LENGTH) return normalized;
  return normalized.slice(-API_KEY_PREVIEW_LENGTH);
}

function buildStoredApiKey(secret, props = {}) {
  const normalized = String(secret || '').trim();
  if (!normalized) return null;
  return {
    label: props.label || null,
    rateLimit: Number(props.rateLimit) || DEFAULT_RATE_LIMIT,
    rateWindow: Number(props.rateWindow) || DEFAULT_RATE_WINDOW,
    active: props.active !== false,
    createdAt: props.createdAt || new Date().toISOString(),
    revokedAt: props.revokedAt || null,
    keyPrefix: props.keyPrefix || deriveApiKeyPrefix(normalized),
    keyPreview: props.keyPreview || deriveApiKeyPreview(normalized),
    secretHash: props.secretHash || hashApiKeySecret(normalized)
  };
}

function normalizeApiKeyRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legacyKey = String(raw.key || '').trim();
  const secretHash = String(raw.secretHash || '').trim();
  if (!secretHash && !legacyKey) return null;
  const record = {
    label: raw.label || null,
    rateLimit: Number(raw.rateLimit) || DEFAULT_RATE_LIMIT,
    rateWindow: Number(raw.rateWindow) || DEFAULT_RATE_WINDOW,
    active: raw.active !== false,
    createdAt: raw.createdAt || null,
    revokedAt: raw.revokedAt || null,
    keyPrefix: raw.keyPrefix || null,
    keyPreview: raw.keyPreview || null,
    secretHash: secretHash || (legacyKey ? hashApiKeySecret(legacyKey) : null)
  };
  if (legacyKey) {
    if (!record.keyPrefix) record.keyPrefix = deriveApiKeyPrefix(legacyKey);
    if (!record.keyPreview) record.keyPreview = deriveApiKeyPreview(legacyKey);
  }
  if (!record.secretHash) return null;
  return record;
}

function normalizeApiKeyList(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeApiKeyRecord)
    .filter(Boolean);
}

function matchesKeyIdentifier(record, identifier) {
  if (!record) return false;
  const cleaned = String(identifier || '').trim();
  if (!cleaned) return false;
  const prefix = String(record.keyPrefix || '');
  const preview = String(record.keyPreview || '');
  if (prefix && prefix.startsWith(cleaned)) return true;
  if (preview && (preview === cleaned || cleaned.endsWith(preview))) return true;
  return false;
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

const PULSE_SEVERITY_LEVELS = Object.freeze(['WATCH', 'HOT', 'CRITICAL', 'ACTION']);

function normalizePulseSeverity(value) {
  const upper = String(value || '').trim().toUpperCase();
  return PULSE_SEVERITY_LEVELS.includes(upper) ? upper : DEFAULT_PULSE_CONFIG.thresholds.minSeverity;
}

function normalizePulseThresholds(raw = {}) {
  const maxMinsToJump = Number(raw?.maxMinsToJump);
  const minMovePct = Number(raw?.minMovePct);
  return {
    minSeverity: normalizePulseSeverity(raw?.minSeverity),
    maxMinsToJump: Number.isFinite(maxMinsToJump) && maxMinsToJump >= 0 ? maxMinsToJump : null,
    minMovePct: Number.isFinite(minMovePct) && minMovePct >= 0 ? minMovePct : null,
    trackedRunnerOverride: raw?.trackedRunnerOverride !== false,
  };
}

function normalizePulseTargetList(values = [], mapper = (v) => v) {
  const items = Array.isArray(values) ? values : [];
  return Array.from(new Set(items.map(mapper).filter(Boolean)));
}

function normalizePulseMeetingName(value) {
  return String(value || '').trim();
}

function normalizePulseCountry(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'HKG') return 'HK';
  return upper;
}

function normalizePulseRaceTarget(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const meeting = normalizePulseMeetingName(value.meeting);
    const race = String(value.race || value.race_number || '').trim().replace(/^R/i, '');
    if (!meeting || !race) return null;
    return `${meeting}::${race}`;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s*\|\s*/g, '::').replace(/\s*[—-]\s*R?/gi, '::');
  const parts = normalized.split('::').map(part => String(part || '').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const race = String(parts.pop() || '').replace(/^R/i, '');
  const meeting = parts.join('::').trim();
  if (!meeting || !race) return null;
  return `${meeting}::${race}`;
}

function normalizePulseTargeting(raw = {}) {
  const mode = String(raw?.mode || 'all').trim().toLowerCase();
  const allowedMode = ['all', 'countries', 'meetings', 'races', 'mixed'].includes(mode) ? mode : 'all';
  return {
    mode: allowedMode,
    countries: normalizePulseTargetList(raw?.countries, normalizePulseCountry),
    meetings: normalizePulseTargetList(raw?.meetings, normalizePulseMeetingName),
    races: normalizePulseTargetList(raw?.races, normalizePulseRaceTarget),
  };
}

function normalizePulseConfig(raw = {}, principal = null) {
  const alertTypes = raw && typeof raw.alertTypes === 'object' ? raw.alertTypes : {};
  return {
    enabled: raw?.enabled !== false,
    alertTypes: {
      plunges: alertTypes.plunges !== false,
      drifts: alertTypes.drifts !== false,
      conflicts: alertTypes.conflicts !== false,
      selectionFlips: alertTypes.selectionFlips !== false,
      preJumpHeat: alertTypes.preJumpHeat !== false,
      jumpPulse: alertTypes.jumpPulse !== false,
    },
    thresholds: normalizePulseThresholds(raw?.thresholds || {}),
    targeting: normalizePulseTargeting(raw?.targeting || {}),
    updatedAt: raw?.updatedAt || null,
    updatedBy: raw?.updatedBy || principal?.username || null,
  };
}

function pulseConfigKeyForAlertType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'hot_plunge') return 'plunges';
  if (t === 'hot_drift') return 'drifts';
  if (t === 'market_conflict') return 'conflicts';
  if (t === 'selection_flip_recommended' || t === 'selection_flip_odds_runner' || t === 'selection_flip_ew') return 'selectionFlips';
  if (t === 'prejump_heat') return 'preJumpHeat';
  if (t === 'jump_pulse') return 'jumpPulse';
  return null;
}

function pulseSeverityRank(value) {
  return PULSE_SEVERITY_LEVELS.indexOf(normalizePulseSeverity(value));
}

function pulseAlertPassesThresholds(row, config) {
  const thresholds = normalizePulseThresholds(config?.thresholds || {});
  if (thresholds.trackedRunnerOverride && row?.trackedRunner) return true;

  if (pulseSeverityRank(row?.severity) < pulseSeverityRank(thresholds.minSeverity)) return false;

  const maxMinsToJump = Number(thresholds.maxMinsToJump);
  const minsToJump = Number(row?.minsToJump);
  if (Number.isFinite(maxMinsToJump) && Number.isFinite(minsToJump) && minsToJump >= 0 && minsToJump > maxMinsToJump) return false;

  const minMovePct = Number(thresholds.minMovePct);
  const movePct = Math.abs(Number(row?.movePct));
  if (Number.isFinite(minMovePct) && Number.isFinite(movePct) && movePct < minMovePct) return false;

  return true;
}

function buildPulseMeetingCountryIndex(racesPayload = { races: [] }) {
  const rows = Array.isArray(racesPayload?.races) ? racesPayload.races : (Array.isArray(racesPayload) ? racesPayload : []);
  const index = new Map();
  rows.forEach((race) => {
    const meeting = normalizePulseMeetingName(race?.meeting).toLowerCase();
    const raceNo = String(race?.race_number || race?.race || '').trim();
    const country = normalizePulseCountry(race?.country);
    if (!meeting || !raceNo || !country) return;
    index.set(`${meeting}::${raceNo}`, country);
    if (!index.has(meeting)) index.set(meeting, country);
  });
  return index;
}

function enrichPulseAlert(row, meetingCountryIndex) {
  if (!row || typeof row !== 'object') return row;
  const meeting = normalizePulseMeetingName(row.meeting);
  const race = String(row.race || '').trim().replace(/^R/i, '');
  const meetingKey = meeting.toLowerCase();
  const country = normalizePulseCountry(
    row.country
    || meetingCountryIndex.get(`${meetingKey}::${race}`)
    || meetingCountryIndex.get(meetingKey)
    || null
  );
  return country ? { ...row, country } : row;
}

function pulseAlertMatchesTargeting(row, config) {
  const targeting = normalizePulseTargeting(config?.targeting || {});
  if (targeting.mode === 'all') return true;
  const meeting = normalizePulseMeetingName(row?.meeting);
  const race = String(row?.race || '').trim().replace(/^R/i, '');
  const country = normalizePulseCountry(row?.country);
  const raceKey = meeting && race ? `${meeting}::${race}` : null;
  const matchers = {
    countries: !!country && targeting.countries.includes(country),
    meetings: !!meeting && targeting.meetings.includes(meeting),
    races: !!raceKey && targeting.races.includes(raceKey),
  };
  if (targeting.mode === 'mixed') return Object.values(matchers).some(Boolean);
  return !!matchers[targeting.mode];
}

function filterAlertsByPulseConfig(rows, config, racesPayload = { races: [] }) {
  const normalizedConfig = normalizePulseConfig(config || {});
  if (normalizedConfig.enabled === false) return [];
  const meetingCountryIndex = buildPulseMeetingCountryIndex(racesPayload);
  const enabled = normalizedConfig.alertTypes || DEFAULT_PULSE_CONFIG.alertTypes;
  return (Array.isArray(rows) ? rows : []).map((row) => enrichPulseAlert(row, meetingCountryIndex)).filter((row) => {
    const key = pulseConfigKeyForAlertType(row?.type);
    if (key && enabled[key] === false) return false;
    if (!pulseAlertMatchesTargeting(row, normalizedConfig)) return false;
    return pulseAlertPassesThresholds(row, normalizedConfig);
  });
}

function normalizeTrackedMultiPayload(payload = {}) {
  const groupType = String(payload.groupType || payload.group_type || '').trim().toLowerCase();
  const groupId = String(payload.groupId || payload.group_id || '').trim();
  const groupLabel = String(payload.groupLabel || payload.group_label || '').trim();
  const groupSizeRaw = Number(payload.groupSize ?? payload.group_size);
  const legIndexRaw = Number(payload.legIndex ?? payload.leg_index);
  const legs = Array.isArray(payload.legs)
    ? payload.legs.map((leg, index) => ({
        meeting: String(leg?.meeting || '').trim(),
        race: String(leg?.race || '').replace(/^R/i, '').trim(),
        selection: String(leg?.selection || '').trim(),
        odds: Number.isFinite(Number(leg?.odds)) ? Number(leg.odds) : null,
        legIndex: Number.isFinite(Number(leg?.legIndex)) ? Number(leg.legIndex) : index + 1,
      })).filter((leg) => leg.meeting && leg.race && leg.selection)
    : [];

  if (groupType !== 'multi' || !groupId) {
    return {
      groupType: null,
      groupId: null,
      groupLabel: null,
      groupSize: null,
      legIndex: null,
      legs: [],
    };
  }

  const derivedGroupSize = Number.isFinite(groupSizeRaw) && groupSizeRaw > 0
    ? Math.round(groupSizeRaw)
    : (legs.length || null);
  const derivedLegIndex = Number.isFinite(legIndexRaw) && legIndexRaw > 0
    ? Math.round(legIndexRaw)
    : null;

  return {
    groupType,
    groupId,
    groupLabel: groupLabel || (derivedGroupSize ? `${derivedGroupSize}-Leg Multi` : 'Multi'),
    groupSize: derivedGroupSize,
    legIndex: derivedLegIndex,
    legs,
  };
}

function normalizeTrackedRunnerName(value) {
  return String(value || '')
    .replace(/^\s*(?:#?\d+|\(\d+\))\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*runner\s*\d+\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*emerg(?:ency)?\s*\d+\s*[.\-:)]*\s*/i, '')
    .trim()
    .toLowerCase();
}

function normalizeTrackedRace(value) {
  return String(value || '').replace(/^R/i, '').trim();
}

function buildTrackedIdentityKey(row = {}) {
  return [
    String(row.meeting || '').trim().toLowerCase(),
    normalizeTrackedRace(row.race || row.race_number),
    normalizeTrackedRunnerName(row.selection || row.runner || row.name),
  ].join('|');
}

function filterTrackedRowsForPrincipal(rows = [], principal = null) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const tenantId = String(principal?.effectiveTenantId || principal?.tenantId || 'default').trim() || 'default';
  if (principal?.isAdmin || tenantId !== 'default') return safeRows;
  const username = normalizeTrackedRunnerName(principal?.username || '');
  return safeRows.filter((row) => normalizeTrackedRunnerName(row?.username || '') === username);
}

function findTrackedDuplicate(rows = [], candidate = {}) {
  const targetKey = buildTrackedIdentityKey(candidate);
  if (!targetKey || targetKey.endsWith('|')) return null;
  return (Array.isArray(rows) ? rows : []).find((row) => {
    if (String(row?.status || '').toLowerCase() === 'settled') return false;
    return buildTrackedIdentityKey(row) === targetKey;
  }) || null;
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
    const candidateHash = sha256(apiKey);

    const legacyAdminHash = String(state?.adminMeta?.apiKeyHash || '').trim();
    if (legacyAdminHash && candidateHash === legacyAdminHash) {
      return {
        keyRecord: {
          label: 'legacy-admin-key',
          active: true,
          createdAt: state?.adminMeta?.apiKeyCreatedAt || null,
          keyPreview: state?.adminMeta?.apiKeyPreview || null,
          secretHash: legacyAdminHash,
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
      { username: state.username, role: 'admin', isAdmin: true, tenantId: 'default', apiKeys: normalizeApiKeyList(state.adminApiKeys) },
      ...(state.users || []).map(u => ({
        username: u.username,
        role: u.role || 'user',
        isAdmin: (u.role || 'user') === 'admin',
        tenantId: u.tenantId || 'default',
        apiTenantId: u.apiTenantId || null,
        planType: u.planType || 'single',
        apiKeys: normalizeApiKeyList(u.apiKeys)
      }))
    ];
    for (const user of allUsers) {
      const keys = user.apiKeys || [];
      const match = keys.find(k => k.secretHash === candidateHash && k.active !== false);
      if (match) {
        return {
          keyRecord: match,
          principal: {
            username: user.username,
            role: user.role,
            isAdmin: user.isAdmin,
            tenantId: user.tenantId,
            apiTenantId: user.apiTenantId || null,
            effectiveTenantId: user.apiTenantId || user.tenantId,
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
      apiError(req, res, 401, 'api_key_required', 'Provide an API key via X-API-Key header or Authorization: Bearer header.');
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

  function readDataFileForPrincipal(principal, filename, fallback) {
    const tenantId = effectiveTenantId(principal);
    const defaultPath = path.join(dataDir, filename);

    // Private tenant reads must never silently fall back to shared default files,
    // otherwise tenant A can observe stale/default tenant B/system data.
    if (isPrivateTenantPrincipal(principal)) {
      return loadJson(resolveTenantOwnedDataPath(tenantId, filename), fallback);
    }

    if (typeof resolveTenantPathById === 'function') {
      return loadJson(resolveTenantPathById(tenantId, defaultPath, filename), fallback);
    }
    if (typeof resolveTenantPath === 'function') {
      return loadJson(resolveTenantPath({ authPrincipal: principal }, defaultPath, filename), fallback);
    }
    return loadJson(defaultPath, fallback);
  }

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  }

  function normalizeTenantId(value) {
    const raw = String(value || 'default').trim();
    const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    return clean || 'default';
  }

  function effectiveTenantId(principal) {
    return normalizeTenantId(principal?.effectiveTenantId || principal?.apiTenantId || principal?.tenantId || 'default');
  }

  function resolveTenantOwnedDataPath(tenantId = 'default', filename) {
    const normalized = normalizeTenantId(tenantId || 'default');
    if (normalized !== 'default') {
      const tenantRoot = path.join(rootDir, 'memory', 'tenants', normalized, 'frontend-data');
      return path.join(tenantRoot, filename);
    }
    return path.join(rootDir, 'frontend', 'data', filename);
  }

  function isPrivateTenantPrincipal(principal = null) {
    return !!principal && !principal.isAdmin && effectiveTenantId(principal) !== 'default';
  }

  function normalizePrincipalUsername(value) {
    const raw = String(value || '').trim();
    return raw.includes('@') ? raw.toLowerCase() : raw;
  }

  function hasPulseAccess(principal = null) {
    return !!principal;
  }

  function loadPulseConfigForTenant(tenantId = 'default') {
    const filePath = resolveTenantOwnedDataPath(tenantId, PULSE_CONFIG_FILE);
    const raw = loadJson(filePath, DEFAULT_PULSE_CONFIG);
    const normalized = normalizePulseConfig(raw);
    const racesPayload = loadJson(resolveTenantOwnedDataPath(tenantId, 'races.json'), { races: [] });
    const raceRows = Array.isArray(racesPayload?.races) ? racesPayload.races : (Array.isArray(racesPayload) ? racesPayload : []);
    const targeting = prunePulseTargetingAgainstRaces(normalized.targeting || {}, raceRows);
    return normalizePulseConfig({ ...normalized, targeting });
  }

  function savePulseConfigForTenant(tenantId = 'default', payload = {}, principal = null) {
    const filePath = resolveTenantOwnedDataPath(tenantId, PULSE_CONFIG_FILE);
    const racesPayload = loadJson(resolveTenantOwnedDataPath(tenantId, 'races.json'), { races: [] });
    const raceRows = Array.isArray(racesPayload?.races) ? racesPayload.races : (Array.isArray(racesPayload) ? racesPayload : []);
    const targeting = prunePulseTargetingAgainstRaces(payload?.targeting || {}, raceRows);
    const next = normalizePulseConfig({
      ...payload,
      targeting,
      updatedAt: new Date().toISOString(),
      updatedBy: principal?.username || payload?.updatedBy || null,
    }, principal);
    writeJson(filePath, next);
    return next;
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
      const races = readDataFileForPrincipal(principal, 'races.json', { races: [] });
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
      const races = readDataFileForPrincipal(principal, 'races.json', { races: [] });
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
            silk_url_64x64: r.silk_url_64x64 || null,
            silk_url_128x128: r.silk_url_128x128 || null,
            alt_silk_url_64x64: r.alt_silk_url_64x64 || null,
            alt_silk_url_128x128: r.alt_silk_url_128x128 || null,
            silk_colours: r.silk_colours || null,
            silkUrl64x64: r.silk_url_64x64 || null,
            silkUrl128x128: r.silk_url_128x128 || null,
            altSilkUrl64x64: r.alt_silk_url_64x64 || null,
            altSilkUrl128x128: r.alt_silk_url_128x128 || null,
            silkColours: r.silk_colours || null,
            stats: r.stats || null
          }))
        }
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/suggested-bets ───────────────────────────────── */
    if (req.method === 'GET' && route === '/suggested-bets') {
      const status = readDataFileForPrincipal(principal, 'status.json', {});
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
      const status = readDataFileForPrincipal(principal, 'status.json', {});
      const races = readDataFileForPrincipal(principal, 'races.json', { races: [] });
      const raceMap = buildRaceMapFromPayload(races);
      const runners = (status.interestingRunners || []).filter((row) => isLiveRaceEntry(row, raceMap));
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
      const status = readDataFileForPrincipal(principal, 'status.json', {});
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
      const trackedPath = resolveTenantOwnedDataPath(tenantId, 'tracked_bets.json');
      const settledPath = resolveTenantOwnedDataPath(tenantId, 'settled_bets.json');
      const racesPath = resolveTenantOwnedDataPath(tenantId, 'races.json');
      const trackedRows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
      const settledRows = Array.isArray(loadJson(settledPath, [])) ? loadJson(settledPath, []) : [];
      const raceMap = buildRaceMapFromPayload(loadJson(racesPath, { races: [] }));
      const raceResultIndex = buildRaceResultIndex(settledRows);
      const normalize = (s) => normalizeTrackedRunnerName(s);
      const privateTenantScope = isPrivateTenantPrincipal(principal);
      const visibleTracked = filterTrackedRowsForPrincipal(trackedRows, principal);
      const resolved = visibleTracked.map((row) => {
        const settled = resolveTrackedBet(row, settledRows, raceResultIndex);
        const raceKey = `${normalizeMeetingName(settled?.meeting)}|${normalizeRaceValue(settled?.race)}`;
        const race = raceMap.get(raceKey) || null;
        const jumpMeta = resolveTrackedRaceJumpMeta(settled, race);
        return {
          ...settled,
          ...(race?.race_status ? { raceStatus: race.race_status } : {}),
          jumpsIn: jumpMeta.jumpsIn,
          minsToJump: jumpMeta.minsToJump,
          raceStartTime: jumpMeta.raceStartTime,
        };
      });
      const recoveredHistory = buildTrackedHistoryRows(principal, resolved, settledRows, raceResultIndex);
      const responseTracked = [...resolved, ...recoveredHistory]
        .sort((a, b) => String(b.settledAt || b.trackedAt || '').localeCompare(String(a.settledAt || a.trackedAt || '')));

      if (req.method === 'GET') {
        const trackedShapeChanged = visibleTracked.length !== resolved.length || visibleTracked.some((row, idx) => {
          const next = resolved[idx] || {};
          return String(row?.id || '') !== String(next?.id || '') ||
            String(row?.meeting || '') !== String(next?.meeting || '') ||
            String(row?.race || '') !== String(next?.race || '') ||
            String(row?.selection || '') !== String(next?.selection || '') ||
            String(row?.raceStatus || '') !== String(next?.raceStatus || '') ||
            String(row?.jumpsIn || '') !== String(next?.jumpsIn || '') ||
            Number(row?.minsToJump) !== Number(next?.minsToJump) ||
            String(row?.raceStartTime || '') !== String(next?.raceStartTime || '');
        });
        if (trackedShapeChanged) {
          if (privateTenantScope) {
            fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
            fs.writeFileSync(trackedPath, JSON.stringify(resolved, null, 2));
          } else {
            const others = trackedRows.filter((row) => normalize(row.username) !== normalize(principal.username));
            fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
            fs.writeFileSync(trackedPath, JSON.stringify([...others, ...resolved], null, 2));
          }
        }
        return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBets: responseTracked }, 200, rateInfo), true;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            let payload = {};
            try { payload = body ? JSON.parse(body) : {}; } catch {}
            const next = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
              username: principal.username,
              createdBy: principal.username,
              trackedBy: principal.username,
              meeting: payload.meeting,
              race: String(payload.race || ''),
              selection: payload.selection,
              betType: payload.betType || payload.type || 'Win',
              odds: payload.odds ?? null,
              entryOdds: payload.entryOdds ?? payload.odds ?? null,
              stake: payload.stake ?? null,
              jumpsIn: payload.jumpsIn ?? null,
              note: payload.note ?? null,
              source: payload.source || 'manual',
              priorityRank: Number.isFinite(Number(payload.priorityRank)) ? Number(payload.priorityRank) : null,
              trackedAt: new Date().toISOString(),
              status: 'active',
              result: 'pending',
              settledAt: null,
              ...normalizeTrackedMultiPayload(payload),
            };
            if (!next.meeting || !next.race || !next.selection) return apiError(req, res, 400, 'invalid_payload', 'meeting, race, and selection are required.', rateInfo);
            const duplicate = findTrackedDuplicate(filterTrackedRowsForPrincipal(trackedRows, principal), next);
            if (duplicate) {
              return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBet: resolveTrackedBet(duplicate, settledRows, raceResultIndex), duplicate: true }, 200, rateInfo);
            }
            fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
            fs.writeFileSync(trackedPath, JSON.stringify([next, ...trackedRows], null, 2));
            return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBet: next }, 200, rateInfo);
          } catch (error) {
            console.error('[api/v1/tracked-bets] POST failed:', error?.stack || error?.message || error);
            return apiError(req, res, 500, 'tracked_bets_write_failed', 'Tracked bets could not be saved right now.', rateInfo);
          }
        });
        return true;
      }
    }

    if (route.startsWith('/tracked-bets/')) {
      const tenantId = principal.effectiveTenantId || principal.tenantId || 'default';
      const trackedPath = resolveTenantOwnedDataPath(tenantId, 'tracked_bets.json');
      const trackedRows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
      const trackedId = decodeURIComponent(route.split('/').pop() || '');
      const normalize = (s) => normalizeTrackedRunnerName(s);
      const privateTenantScope = isPrivateTenantPrincipal(principal);

      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            let payload = {};
            try { payload = body ? JSON.parse(body) : {}; } catch {}
            const updated = trackedRows.map((row) => {
              if (String(row.id) !== trackedId) return row;
              if (!privateTenantScope && !principal.isAdmin && normalize(row.username) !== normalize(principal.username)) return row;
              return {
                ...row,
                ...payload,
                priorityRank: payload.priorityRank === null || payload.priorityRank === undefined
                  ? row.priorityRank ?? null
                  : (Number.isFinite(Number(payload.priorityRank)) ? Number(payload.priorityRank) : row.priorityRank ?? null),
                id: row.id,
                username: row.username,
              };
            });
            fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
            fs.writeFileSync(trackedPath, JSON.stringify(updated, null, 2));
            return apiJson(req, res, { ok: true, api_version: API_VERSION, trackedBet: updated.find((r) => String(r.id) === trackedId) || null }, 200, rateInfo);
          } catch (error) {
            console.error('[api/v1/tracked-bets] PATCH failed:', error?.stack || error?.message || error);
            return apiError(req, res, 500, 'tracked_bets_write_failed', 'Tracked bets could not be updated right now.', rateInfo);
          }
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const updated = trackedRows.filter((row) => {
          if (String(row.id) !== trackedId) return true;
          if (privateTenantScope || principal.isAdmin) return false;
          return normalize(row.username) !== normalize(principal.username);
        });
        fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
        fs.writeFileSync(trackedPath, JSON.stringify(updated, null, 2));
        return apiJson(req, res, { ok: true, api_version: API_VERSION }, 200, rateInfo), true;
      }
    }

    /* ── GET/POST /api/v1/heatmap + detail placeholders ───────────── */
    if (req.method === 'GET' && route === '/heatmap') {
      const data = readDataFileForPrincipal(principal, 'heatmap_observations.json', { observations: [] });
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
        const existing = readDataFileForPrincipal(principal, 'heatmap_observations.json', { observations: [] });
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
        fs.mkdirSync(path.dirname(resolveTenantOwnedDataPath(effectiveTenantId(principal), 'heatmap_observations.json')), { recursive: true });
        fs.writeFileSync(resolveTenantOwnedDataPath(effectiveTenantId(principal), 'heatmap_observations.json'), JSON.stringify(next, null, 2));
        return apiJson(req, res, { ok: true, api_version: API_VERSION, observation }, 200, rateInfo);
      });
      return true;
    }

    if (req.method === 'GET' && route.startsWith('/heatmap/')) {
      const parts = route.split('/').filter(Boolean);
      const data = readDataFileForPrincipal(principal, 'heatmap_observations.json', { observations: [] });
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
      if (!hasPulseAccess(principal)) {
        return apiError(req, res, 403, 'pulse_sign_in_required', 'Sign in to access Pulse.', rateInfo), true;
      }
      const tenantId = effectiveTenantId(principal);
      const dataPath = resolveTenantOwnedDataPath(tenantId, 'alerts_feed.json');
      const data = loadJson(dataPath, { updatedAt: null, alerts: [] });
      const config = loadPulseConfigForTenant(tenantId);
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        updatedAt: data.updatedAt || null,
        alerts: filterAlertsByPulseConfig(Array.isArray(data.alerts) ? data.alerts : [], config, loadJson(resolveTenantOwnedDataPath(tenantId, 'races.json'), { races: [] }))
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/alerts-history ────────────────────────────────── */
    if (req.method === 'GET' && route === '/alerts-history') {
      if (!hasPulseAccess(principal)) {
        return apiError(req, res, 403, 'pulse_sign_in_required', 'Sign in to access Pulse.', rateInfo), true;
      }
      const tenantId = effectiveTenantId(principal);
      const dataPath = resolveTenantOwnedDataPath(tenantId, 'alerts_history.json');
      const data = loadJson(dataPath, []);
      const config = loadPulseConfigForTenant(tenantId);
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        alerts: filterAlertsByPulseConfig(Array.isArray(data) ? data : [], config, loadJson(resolveTenantOwnedDataPath(tenantId, 'races.json'), { races: [] }))
      }, 200, rateInfo), true;
    }

    /* ── GET/PUT/PATCH /api/v1/pulse-config ───────────────────────── */
    if (route === '/pulse-config') {
      if (!hasPulseAccess(principal)) {
        return apiError(req, res, 403, 'pulse_sign_in_required', 'Sign in to access Pulse.', rateInfo), true;
      }
      const tenantId = effectiveTenantId(principal);

      if (req.method === 'GET') {
        return apiJson(req, res, {
          ok: true,
          api_version: API_VERSION,
          config: loadPulseConfigForTenant(tenantId)
        }, 200, rateInfo), true;
      }

      if (req.method === 'PUT' || req.method === 'PATCH') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let payload = {};
          try { payload = body ? JSON.parse(body) : {}; } catch {}
          const current = loadPulseConfigForTenant(tenantId);
          const next = savePulseConfigForTenant(tenantId, {
            ...current,
            enabled: payload?.enabled !== undefined ? payload.enabled : current.enabled,
            alertTypes: {
              ...current.alertTypes,
              ...(payload?.alertTypes || {}),
            },
            thresholds: {
              ...current.thresholds,
              ...(payload?.thresholds || {}),
            },
            targeting: {
              ...current.targeting,
              ...(payload?.targeting || {}),
            }
          }, principal);
          return apiJson(req, res, {
            ok: true,
            api_version: API_VERSION,
            config: next
          }, 200, rateInfo);
        });
        return true;
      }
    }

    /* ── GET /api/v1/learnings-report ──────────────────────────────── */
    if (req.method === 'GET' && route === '/learnings-report') {
      const tenantId = principal.effectiveTenantId || principal.tenantId || 'default';
      const learningsPath = resolveTenantPathById
        ? resolveTenantPathById(tenantId, path.join(rootDir, 'frontend', 'data', 'learnings_report.json'), 'learnings_report.json')
        : path.join(rootDir, 'frontend', 'data', 'learnings_report.json');
      const data = loadJson(learningsPath, {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        ...data
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/status ───────────────────────────────────────── */
    if (req.method === 'GET' && route === '/status') {
      const status = readDataFileForPrincipal(principal, 'status.json', {});
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
      const data = readDataFileForPrincipal(principal, fileMap[period], {});
      return apiJson(req, res, {
        ok: true,
        api_version: API_VERSION,
        period,
        data
      }, 200, rateInfo), true;
    }

    /* ── GET /api/v1/stake-config ─────────────────────────────────── */
    if (req.method === 'GET' && route === '/stake-config') {
      const stake = readDataFileForPrincipal(principal, 'stake.json', {});
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
          const races = readDataFileForPrincipal(principal, 'races.json', { races: [] });
          const status = readDataFileForPrincipal(principal, 'status.json', {});
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
      const results = readDataFileForPrincipal(principal, 'bet_results.json', []);
      const placed = readDataFileForPrincipal(principal, 'placed_bets.json', []);
      const settled = readDataFileForPrincipal(principal, 'settled_bets.json', []);
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
        normalizeApiKeyList(state.adminApiKeys).forEach(k => {
          const prefix = k?.keyPrefix ? `${k.keyPrefix}…` : (k?.keyPreview ? `…${k.keyPreview}` : 'n/a');
          allKeys.push({ username: state.username, role: 'admin', label: k.label || null, keyPrefix: prefix, active: k.active !== false, createdAt: k.createdAt || null });
        });
        (state.users || []).forEach(u => {
          normalizeApiKeyList(u.apiKeys).forEach(k => {
            const prefix = k?.keyPrefix ? `${k.keyPrefix}…` : (k?.keyPreview ? `…${k.keyPreview}` : 'n/a');
            allKeys.push({ username: u.username, role: u.role || 'user', label: k.label || null, keyPrefix: prefix, active: k.active !== false, createdAt: k.createdAt || null });
          });
        });
        return apiJson(req, res, { ok: true, api_version: API_VERSION, keys: allKeys }, 200, rateInfo), true;
      } else {
        const principalUsername = normalizePrincipalUsername(principal.username);
        const userRec = (state.users || []).find(u => normalizePrincipalUsername(u.username) === principalUsername);
        const keys = normalizeApiKeyList(userRec?.apiKeys).map(k => ({
          label: k.label || null,
          keyPrefix: k?.keyPrefix ? `${k.keyPrefix}…` : (k?.keyPreview ? `…${k.keyPreview}` : 'n/a'),
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
          const targetUserNormalized = normalizePrincipalUsername(targetUser);
          const rateLimit = principal.isAdmin ? (Number(payload.rateLimit) || DEFAULT_RATE_LIMIT) : DEFAULT_RATE_LIMIT;
          const rateWindow = principal.isAdmin ? (Number(payload.rateWindow) || DEFAULT_RATE_WINDOW) : DEFAULT_RATE_WINDOW;

          const apiKeySecret = generateApiKey();
          const createdAtIso = new Date().toISOString();
          const storedKey = buildStoredApiKey(apiKeySecret, {
            label,
            rateLimit,
            rateWindow,
            active: true,
            createdAt: createdAtIso
          });
          if (!storedKey) {
            apiError(req, res, 500, 'api_key_generation_failed', 'Unable to generate API key.', rateInfo);
            return resolve(true);
          }

          const state = getAuthState();
          const isAdminUser = targetUserNormalized === normalizePrincipalUsername(state.username);

          if (isAdminUser) {
            if (!principal.isAdmin) {
              apiError(req, res, 403, 'forbidden', 'Cannot create keys for admin account.', rateInfo);
              return resolve(true);
            }
            const revokedAt = createdAtIso;
            const adminKeys = normalizeApiKeyList(state.adminApiKeys || []).map((key) =>
              key.active !== false ? { ...key, active: false, revokedAt: key.revokedAt || revokedAt } : key,
            );
            adminKeys.push(storedKey);
            persistAuthState({ ...state, adminApiKeys: adminKeys });
          } else {
            const users = [...(state.users || [])];
            const idx = users.findIndex(u => normalizePrincipalUsername(u.username) === targetUserNormalized);
            if (idx < 0) {
              apiError(req, res, 404, 'user_not_found', `User "${targetUser}" not found.`, rateInfo);
              return resolve(true);
            }
            const revokedAt = createdAtIso;
            const userKeys = normalizeApiKeyList(users[idx].apiKeys || []).map((key) =>
              key.active !== false ? { ...key, active: false, revokedAt: key.revokedAt || revokedAt } : key,
            );
            userKeys.push(storedKey);
            users[idx] = { ...users[idx], apiKeys: userKeys };
            persistAuthState({ ...state, users });
          }

          apiJson(req, res, {
            ok: true,
            api_version: API_VERSION,
            message: 'API key created. Store the key securely — it cannot be retrieved again.',
            key: apiKeySecret,
            keyPreview: storedKey.keyPreview,
            label: storedKey.label,
            username: targetUser,
            rateLimit: storedKey.rateLimit,
            rateWindow: storedKey.rateWindow,
            createdAt: storedKey.createdAt
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
          const rawIdentifier = String(payload.keyPrefix || payload.keyIdentifier || '').trim();
          const keyIdentifier = rawIdentifier.replace(/…/g, '');
          const keyFull = String(payload.key || '').trim();
          const candidateHash = keyFull ? sha256(keyFull) : null;

          if (!keyIdentifier && !candidateHash) {
            apiError(req, res, 400, 'missing_key', 'Provide "key" (full key) or "keyPrefix" to identify the key to revoke.', rateInfo);
            return resolve(true);
          }

          const state = getAuthState();
          let found = false;

          function matchKey(k) {
            if (!k) return false;
            if (candidateHash && k.secretHash === candidateHash) return true;
            if (keyIdentifier && matchesKeyIdentifier(k, keyIdentifier)) return true;
            return false;
          }

          // Check admin keys
          if (principal.isAdmin && state.adminApiKeys) {
            const adminKeys = normalizeApiKeyList(state.adminApiKeys).slice();
            const idx = adminKeys.findIndex(matchKey);
            if (idx >= 0) {
              adminKeys[idx] = { ...adminKeys[idx], active: false, revokedAt: new Date().toISOString() };
              persistAuthState({ ...state, adminApiKeys: adminKeys });
              found = true;
            }
          }

          // Check user keys
          if (!found) {
            const users = [...(state.users || [])];
            for (let i = 0; i < users.length; i++) {
              const userKeys = normalizeApiKeyList(users[i].apiKeys || []).slice();
              const kidx = userKeys.findIndex(matchKey);
              if (kidx >= 0) {
                if (!principal.isAdmin && users[i].username !== principal.username) {
                  apiError(req, res, 403, 'forbidden', 'You can only revoke your own API keys.', rateInfo);
                  return resolve(true);
                }
                userKeys[kidx] = { ...userKeys[kidx], active: false, revokedAt: new Date().toISOString() };
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
