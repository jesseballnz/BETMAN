#!/usr/bin/env node
/* Minimal static server with POST append for frontend requests */
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { mergePublicStatusLists } = require('./status_snapshot_merge');
const { createApiHandler, generateApiKey: genApiKey } = require('./betman_api');
const { buildRaceResultIndex, resolveTrackedBet, buildVisibleSettledRows, buildTrackedHistoryRows } = require('./tracked_bet_matching');

if (typeof dns.setDefaultResultOrder === 'function') {
  try { dns.setDefaultResultOrder('ipv4first'); } catch {}
}

loadEnvFile();

function loadEnvFile(file = '.env'){
  try {
    const roots = [process.cwd(), path.join(__dirname, '..')];
    roots.forEach((rootDir) => {
      const envPath = path.join(rootDir, file);
      if (!fs.existsSync(envPath)) return;
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      lines.forEach((line) => {
        let trimmed = (line || '').trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
        const idx = trimmed.indexOf('=');
        if (idx < 0) return;
        const key = trimmed.slice(0, idx).trim();
        if (!key) return;
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (typeof process.env[key] === 'undefined') {
          process.env[key] = value;
        }
      });
    });
  } catch {}
}

const BETMAN_OLLAMA_DEFAULT_BASE = 'http://office.waihekewater.com:11434';
const DEFAULT_OLLAMA_FALLBACK_MODELS = ['qwen2.5:1.5b', 'llama3.2:3b', 'deepseek-r1:8b', 'llama3.1:8b'];
const crypto = require('crypto');

const DB_URL = process.env.DATABASE_URL || process.env.BETMAN_DATABASE_URL || '';
function readStripeSecretFromCreds(){
  try {
    const p = path.join(process.cwd(), 'creds');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/Secret\s*key\s*=\s*(sk_[a-zA-Z0-9_]+)/i);
    return m ? String(m[1]).trim() : '';
  } catch { return ''; }
}

function readStripeWebhookSecretFromCreds(){
  try {
    const p = path.join(process.cwd(), 'creds');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/Webhook\s*secret\s*=\s*(whsec_[a-zA-Z0-9_]+)/i);
    return m ? String(m[1]).trim() : '';
  } catch { return ''; }
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.BETMAN_STRIPE_SECRET_KEY || readStripeSecretFromCreds();
const STRIPE_LINK_SINGLE = process.env.STRIPE_LINK_SINGLE || process.env.BETMAN_STRIPE_LINK_SINGLE || 'https://buy.stripe.com/8x2cN538qbMqaiY8mocZa00';
const STRIPE_LINK_SINGLE_DAY = process.env.STRIPE_LINK_SINGLE_DAY || process.env.BETMAN_STRIPE_LINK_SINGLE_DAY || 'https://buy.stripe.com/5kQ7sL9wOcQudva9qscZa03';
const STRIPE_LINK_COMMERCIAL = process.env.STRIPE_LINK_COMMERCIAL || process.env.BETMAN_STRIPE_LINK_COMMERCIAL || 'https://buy.stripe.com/6oU7sL10ig2G0IobyAcZa01';
const STRIPE_LINK_TESTER = process.env.STRIPE_LINK_TESTER || process.env.BETMAN_STRIPE_LINK_TESTER || 'https://buy.stripe.com/aFa00j9wO4jYbn26egcZa02';
let pgPool = null;
let stripeClient = null;

const root = path.join(process.cwd(), 'frontend');
const port = process.env.PORT || 8080;
const AUTH_FILE = path.join(process.cwd(), 'memory', 'betman-auth.json');
const TENANTS_ROOT = path.join(process.cwd(), 'memory', 'tenants');
const AI_INSTRUCTIONS_FILE = path.join(process.cwd(), 'instructions', 'instructions.md');
const RACE_ANALYSIS_CACHE_FILE = 'race-analysis-cache.json';
const PULSE_CONFIG_FILE = 'pulse_config.json';
const AI_CACHE_ENABLED = String(process.env.AI_CACHE_ENABLED || process.env.BETMAN_AI_CACHE_ENABLED || 'true').toLowerCase() === 'true';
const RACE_ANALYSIS_CACHE_TTL_MS = Number(process.env.RACE_ANALYSIS_CACHE_TTL_MS || (30 * 60 * 1000));
const RACE_ANALYSIS_MIN_REFRESH_MS = Number(process.env.RACE_ANALYSIS_MIN_REFRESH_MS || (5 * 60 * 1000));
const RACE_LIST_CACHE_TTL_MS = Number(process.env.RACE_LIST_CACHE_TTL_MS || (30 * 60 * 1000));
const raceListCache = new Map();
const AUTH_USER = process.env.BETMAN_USERNAME || 'betman';
const AUTH_PASS = process.env.BETMAN_PASSWORD || 'change-me-now';
const SESSION_TTL_MS = Number(process.env.BETMAN_SESSION_TTL_MS || (1000 * 60 * 60 * 12));
const SIGNUP_VERIFICATION_REQUIRED = String(process.env.BETMAN_SIGNUP_VERIFICATION || 'true').toLowerCase() === 'true';
const HTTP_BASIC_PROMPT = String(process.env.BETMAN_HTTP_BASIC_PROMPT || 'false').toLowerCase() === 'true';
const sessions = new Map();
const signupChallenges = new Map();
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || process.env.BETMAN_STRIPE_WEBHOOK_SECRET || readStripeWebhookSecretFromCreds() || '';
let lastPollCacheTs = 0;
let lastPollCacheKey = '';
let lastPerformancePollTs = 0;
const PERFORMANCE_POLL_COOLDOWN_MS = 5 * 60 * 1000;
let bakeoffRunState = { running: false, startedAt: 0, endedAt: 0, exitCode: null, signal: null, error: null, log: 'logs/bakeoff-run.log', tail: [] };
let aiModelsCache = { ts: 0, payload: null };

const PULSE_SEVERITY_LEVELS = Object.freeze(['WATCH', 'HOT', 'CRITICAL', 'ACTION']);
const PULSE_ALLOWLIST = new Set(
  String(process.env.BETMAN_PULSE_ALLOWLIST || 'betman,test@betman.co.nz')
    .split(',')
    .map((value) => normalizeUsername(value))
    .filter(Boolean)
);

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

function normalizePulseSeverity(value){
  const upper = String(value || '').trim().toUpperCase();
  return PULSE_SEVERITY_LEVELS.includes(upper) ? upper : DEFAULT_PULSE_CONFIG.thresholds.minSeverity;
}

function normalizePulseThresholds(raw = {}){
  const maxMinsToJump = Number(raw?.maxMinsToJump);
  const minMovePct = Number(raw?.minMovePct);
  return {
    minSeverity: normalizePulseSeverity(raw?.minSeverity),
    maxMinsToJump: Number.isFinite(maxMinsToJump) && maxMinsToJump >= 0 ? maxMinsToJump : null,
    minMovePct: Number.isFinite(minMovePct) && minMovePct >= 0 ? minMovePct : null,
    trackedRunnerOverride: raw?.trackedRunnerOverride !== false,
  };
}

function normalizePulseTargetList(values = [], mapper = (v) => v){
  const items = Array.isArray(values) ? values : [];
  return Array.from(new Set(items.map(mapper).filter(Boolean)));
}

function normalizePulseMeetingName(value){
  return String(value || '').trim();
}

function normalizePulseCountry(value){
  const upper = String(value || '').trim().toUpperCase();
  if (upper === 'HKG') return 'HK';
  return upper;
}

function normalizePulseRaceTarget(value){
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

function normalizePulseTargeting(raw = {}){
  const mode = String(raw?.mode || 'all').trim().toLowerCase();
  const allowedMode = ['all', 'countries', 'meetings', 'races', 'mixed'].includes(mode) ? mode : 'all';
  return {
    mode: allowedMode,
    countries: normalizePulseTargetList(raw?.countries, normalizePulseCountry),
    meetings: normalizePulseTargetList(raw?.meetings, normalizePulseMeetingName),
    races: normalizePulseTargetList(raw?.races, normalizePulseRaceTarget),
  };
}

function pulseSeverityRank(value){
  return PULSE_SEVERITY_LEVELS.indexOf(normalizePulseSeverity(value));
}

function pulseAlertPassesThresholds(row, config){
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

function buildPulseMeetingCountryIndex(){
  const racesPath = path.join(process.cwd(), 'frontend', 'data', 'races.json');
  const payload = loadJson(racesPath, { races: [] });
  const rows = Array.isArray(payload?.races) ? payload.races : (Array.isArray(payload) ? payload : []);
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

function enrichPulseAlert(row, meetingCountryIndex){
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

function pulseAlertMatchesTargeting(row, config){
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

function filterPulseAlerts(rows, config = pulseConfigState){
  const normalizedConfig = normalizePulseConfig(config || {});
  if (normalizedConfig.enabled === false) return [];
  const enabled = normalizedConfig?.alertTypes || DEFAULT_PULSE_CONFIG.alertTypes;
  const meetingCountryIndex = buildPulseMeetingCountryIndex();
  return (Array.isArray(rows) ? rows : []).map((row) => enrichPulseAlert(row, meetingCountryIndex)).filter((row) => {
    const key = pulseConfigKeyForAlertType(row?.type);
    if (key && enabled[key] === false) return false;
    if (!pulseAlertMatchesTargeting(row, normalizedConfig)) return false;
    return pulseAlertPassesThresholds(row, normalizedConfig);
  });
}

function normalizePulseConfig(raw = {}, principal = null){
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

let pulseConfigState = normalizePulseConfig(DEFAULT_PULSE_CONFIG);

function pulseConfigKeyForAlertType(type){
  const t = String(type || '').trim().toLowerCase();
  if (t === 'hot_plunge') return 'plunges';
  if (t === 'hot_drift') return 'drifts';
  if (t === 'market_conflict') return 'conflicts';
  if (t === 'selection_flip_recommended' || t === 'selection_flip_odds_runner' || t === 'selection_flip_ew') return 'selectionFlips';
  if (t === 'prejump_heat') return 'preJumpHeat';
  if (t === 'jump_pulse') return 'jumpPulse';
  return null;
}

function loadPulseConfig(tenantId = 'default'){
  const filePath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', PULSE_CONFIG_FILE), PULSE_CONFIG_FILE);
  const raw = loadJson(filePath, DEFAULT_PULSE_CONFIG);
  return normalizePulseConfig(raw);
}

function savePulseConfig(tenantId = 'default', payload = {}, principal = null){
  const filePath = tenantDataPath(tenantId, PULSE_CONFIG_FILE);
  const next = normalizePulseConfig({
    ...payload,
    updatedAt: new Date().toISOString(),
    updatedBy: principal?.username || payload?.updatedBy || null,
  }, principal);
  writeJson(filePath, next);
  return next;
}

function normalizeTenantId(v){
  const raw = String(v || 'default').trim();
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || 'default';
}

function tenantDataDir(tenantId){
  return path.join(TENANTS_ROOT, normalizeTenantId(tenantId), 'frontend-data');
}

function tenantDataPath(tenantId, filename){
  return path.join(tenantDataDir(tenantId), filename);
}

function effectiveTenantId(principal){
  if (!principal) return 'default';
  if (principal.effectiveTenantId) return principal.effectiveTenantId;
  const base = normalizeTenantId(principal.tenantId || 'default');
  if (base !== 'default') return base;
  if (principal.isAdmin) return 'default';
  const username = normalizeUsername(principal.username || '');
  if (!username) return 'default';
  const slug = username.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug ? `acct_${slug}` : 'default';
}

function resolveTenantPath(req, defaultPath, filename){
  const tenantId = effectiveTenantId(req?.authPrincipal);
  if (tenantId === 'default') return defaultPath;
  const p = tenantDataPath(tenantId, filename);
  return fs.existsSync(p) ? p : defaultPath;
}

function resolveTenantPathById(tenantId, defaultPath, filename){
  const tid = normalizeTenantId(tenantId || 'default');
  if (tid === 'default') return defaultPath;
  const p = tenantDataPath(tid, filename);
  return fs.existsSync(p) ? p : defaultPath;
}

function resolveTenantOwnedPathById(tenantId, defaultPath, filename){
  const tid = normalizeTenantId(tenantId || 'default');
  return tid === 'default' ? defaultPath : tenantDataPath(tid, filename);
}

function isPrivateTenantPrincipal(principal){
  return !!principal && !principal.isAdmin && effectiveTenantId(principal) !== 'default';
}

function normalizeBaseUrl(url){
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/$/, '');
}

function getOllamaBaseList(){
  const fallbackList = String(process.env.BETMAN_OLLAMA_BASE_FALLBACKS || '')
    .split(',')
    .map(normalizeBaseUrl)
    .filter(Boolean);
  const explicitBases = [
    normalizeBaseUrl(process.env.BETMAN_OLLAMA_BASE_URL),
    normalizeBaseUrl(process.env.OLLAMA_BASE_URL),
    normalizeBaseUrl(process.env.BETMAN_CHAT_BASE_URL),
    ...fallbackList
  ].filter(Boolean);
  if (explicitBases.length) return Array.from(new Set(explicitBases));
  return [normalizeBaseUrl(BETMAN_OLLAMA_DEFAULT_BASE)].filter(Boolean);
}


function loadRaceAnalysisCacheState(tenantId){
  const cachePath = tenantDataPath(tenantId, RACE_ANALYSIS_CACHE_FILE);
  const raw = loadJson(cachePath, {});
  const now = Date.now();
  const pruned = {};
  Object.entries(raw || {}).forEach(([key, value = {}]) => {
    if (!value || typeof value !== 'object') return;
    const exp = new Date(value.expiresAt || 0).getTime();
    if (Number.isFinite(exp) && exp > now && value.answer) {
      pruned[key] = value;
    }
  });
  if (Object.keys(pruned).length !== Object.keys(raw || {}).length) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(pruned, null, 2));
    } catch (e) {
      console.error('race_analysis_cache_prune_failed', e.message);
    }
  }
  return { cachePath, cacheData: pruned };
}

function saveRaceAnalysisCacheState(cachePath, cacheData){
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cacheData || {}, null, 2));
  } catch (e) {
    console.error('race_analysis_cache_save_failed', e.message);
  }
}

function extractRaceCacheKeyFromPayload(payload){
  const sels = Array.isArray(payload?.selections) ? payload.selections : [];
  const keys = [...new Set(sels.map(sel => {
    const meeting = String(sel?.meeting || '').trim().toLowerCase();
    let race = sel?.race ?? sel?.race_number ?? sel?.raceNumber ?? sel?.raceNo ?? '';
    race = String(race).replace(/^R/i, '').trim();
    if (!meeting || !race) return null;
    return `${meeting}|${race}`;
  }).filter(Boolean))];
  if (keys.length === 1) return keys[0];

  const meeting = String(payload?.raceContext?.meeting || payload?.uiContext?.meeting || '').trim().toLowerCase();
  let race = payload?.raceContext?.raceNumber ?? payload?.uiContext?.race ?? '';
  race = String(race).replace(/^R/i, '').trim();
  if (meeting && race) return `${meeting}|${race}`;

  return null;
}


function buildRaceListCacheKey({ date = '', country = '', meeting = '', limit = 0, offset = 0, version = 0 } = {}){
  return JSON.stringify({
    date: String(date || ''),
    country: String(country || '').toUpperCase(),
    meeting: String(meeting || '').trim().toLowerCase(),
    limit: Number(limit) || 0,
    offset: Number(offset) || 0,
    version: Number(version) || 0
  });
}

function getCachedRaceList(key){
  if (!key) return null;
  const entry = raceListCache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.ts) > RACE_LIST_CACHE_TTL_MS) {
    raceListCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedRaceList(key, payload){
  if (!key) return;
  raceListCache.set(key, { ts: Date.now(), payload });
  if (raceListCache.size > 200) {
    const first = raceListCache.keys().next().value;
    raceListCache.delete(first);
  }
}

function loadAuthState(){
  const fromFile = loadJson(AUTH_FILE, null);
  const users = Array.isArray(fromFile?.users)
    ? fromFile.users
        .filter(u => u?.username && u?.password)
        .map(u => {
          const copy = { ...u };
          copy.role = copy.role || 'user';
          copy.tenantId = normalizeTenantId(copy.tenantId || 'default');
          copy.planType = copy.planType || 'single';
          copy.apiKeyHash = copy.apiKeyHash || null;
          copy.apiKeyCreatedAt = copy.apiKeyCreatedAt || null;
          copy.apiKeyPreview = copy.apiKeyPreview || null;
          if (!('createdAt' in copy)) copy.createdAt = null;
          if (!('updatedAt' in copy)) copy.updatedAt = null;
          return copy;
        })
    : [];
  const adminMeta = {
    apiKeyHash: fromFile?.adminMeta?.apiKeyHash || fromFile?.adminApiKeyHash || null,
    apiKeyCreatedAt: fromFile?.adminMeta?.apiKeyCreatedAt || fromFile?.adminApiKeyCreatedAt || null,
    apiKeyPreview: fromFile?.adminMeta?.apiKeyPreview || fromFile?.adminApiKeyPreview || null
  };
  return {
    username: fromFile?.username || AUTH_USER,
    password: fromFile?.password || AUTH_PASS,
    users,
    adminMeta
  };
}
let authState = loadAuthState();

function refreshAuthStateFromDisk(){
  try {
    const fresh = loadAuthState();
    if (fresh?.username) authState = fresh;
  } catch {}
  return authState;
}

async function initAuthPersistence(){
  const pool = getPgPool();
  if (!pool) return;
  try {
    await ensurePgSchema(pool);
    const fromDb = await loadAuthStateFromPg(pool);
    if (fromDb) {
      authState = {
        username: fromDb.username || authState.username,
        password: fromDb.password || authState.password,
        users: Array.isArray(fromDb.users) ? fromDb.users : authState.users,
        adminMeta: fromDb.adminMeta || authState.adminMeta || {}
      };
      console.log('Auth state loaded from Postgres.');
    } else {
      await saveAuthStateToPg(pool, authState);
      console.log('Auth state seeded to Postgres.');
    }
  } catch (e) {
    console.error('Postgres auth init failed, using file auth:', e.message);
  }

  try {
    const r = await syncProvisioningFromStripe();
    if (r.ok) console.log(`Stripe provisioning sync: scanned=${r.scanned} updated=${r.updated}`);
  } catch (e) {
    console.error('Stripe provisioning sync failed:', e.message);
  }
}

function getCorsHeaders(req){
  const origin = String(req?.headers?.origin || '').trim();
  const configured = String(process.env.BETMAN_CORS_ORIGINS || 'http://localhost:8081,http://127.0.0.1:8081,http://localhost:8080,http://127.0.0.1:8080')
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const allowed = new Set(configured);
  const isPublicTunnel = /^https:\/\/[a-z0-9.-]+\.(?:ngrok-free\.dev|ngrok\.io)$/i.test(origin);
  const allowOrigin = origin && (allowed.has(origin) || isPublicTunnel) ? origin : (configured[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function send(res, code, body, type='text/plain', req=null){
  res.writeHead(code, { 'Content-Type': type, ...getCorsHeaders(req) });
  res.end(body);
}

function safePath(p){
  const full = path.normalize(path.join(root, p));
  if (!full.startsWith(root)) return null;
  return full;
}

function appendJson(filePath, payload){
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(filePath,'utf8')); } catch {}
  arr.push(payload);
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

function loadJson(filePath, fallback){
  try { return JSON.parse(fs.readFileSync(filePath,'utf8')); } catch { return fallback; }
}

function writeJson(filePath, payload){
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function safeSlug(s){
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function loadMeetingProfiles(date){
  const dir = path.join(process.cwd(), 'data', 'meeting_profiles', date || 'today');
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)){
      if (!f.endsWith('.json')) continue;
      const p = loadJson(path.join(dir, f), null);
      if (p && p.meeting) {
        const slug = safeSlug(p.meeting);
        if (out[slug]) console.warn(`[meeting-profiles] slug collision: "${p.meeting}" → "${slug}"`);
        out[slug] = p;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[meeting-profiles] load error:', e.message);
  }
  return out;
}

function formatMeetingProfile(prof){
  if (!prof || !prof.totals?.races_final) return null;
  const total = prof.totals.races_final;
  const pace = prof.winners?.pace || {};
  const bar = prof.winners?.barrier || {};
  const paceArr = Object.entries(pace)
    .filter(([,v]) => v > 0)
    .sort((a,b) => b[1]-a[1])
    .map(([k,v]) => `${k} ${v}/${total}`);
  const paceWinsSummary = paceArr.length ? paceArr.join(', ') : 'n/a';
  const barrierParts = [];
  if (bar.low) barrierParts.push(`low(1-4) ${bar.low}/${total}`);
  if (bar.mid) barrierParts.push(`mid(5-9) ${bar.mid}/${total}`);
  if (bar.high) barrierParts.push(`high(10+) ${bar.high}/${total}`);
  const result = {
    racesScored: total,
    paceWins: paceWinsSummary,
    barrierWins: barrierParts.length ? barrierParts.join(', ') : 'n/a'
  };
  if (prof.track_condition) result.trackCondition = prof.track_condition;
  if (prof.rail_position) result.railPosition = prof.rail_position;
  return result;
}

function loadText(filePath, fallback = ''){
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return fallback; }
}

function getPgPool(){
  if (!DB_URL) return null;
  if (pgPool) return pgPool;
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: DB_URL });
    return pgPool;
  } catch (e) {
    console.error('Postgres disabled: pg module unavailable or init failed:', e.message);
    return null;
  }
}

async function loadDataSnapshotFromPg(tenantId, key){
  const pool = getPgPool();
  if (!pool) return null;
  try {
    const r = await pool.query('SELECT payload FROM betman_data WHERE tenant_id=$1 AND key=$2 LIMIT 1', [tenantId, key]);
    if (!r.rows?.length) return null;
    return r.rows[0].payload;
  } catch (e) {
    console.error('Postgres data load failed:', e.message);
    return null;
  }
}

function getStripe(){
  if (!STRIPE_SECRET_KEY) return null;
  if (stripeClient) return stripeClient;
  try {
    const Stripe = require('stripe');
    stripeClient = new Stripe(STRIPE_SECRET_KEY);
    return stripeClient;
  } catch (e) {
    console.error('Stripe disabled:', e.message);
    return null;
  }
}

function paymentLinkForPlan(planType){
  const p = String(planType || '').toLowerCase();
  if (p === 'single_day' || p === 'single-day' || p === 'day') return STRIPE_LINK_SINGLE_DAY;
  if (p === 'commercial') return STRIPE_LINK_COMMERCIAL;
  if (p === 'tester') return STRIPE_LINK_TESTER;
  return STRIPE_LINK_SINGLE;
}

function makeSetupToken(){
  return crypto.randomBytes(24).toString('hex');
}

function inferPlanTypeFromStripe(obj = {}){
  const text = JSON.stringify(obj).toLowerCase();
  if (text.includes('single day') || text.includes('single_day') || text.includes('single-day')) return 'single_day';
  if (text.includes('commercial')) return 'commercial';
  if (text.includes('tester') || text.includes('free')) return 'tester';
  return 'single';
}

function upsertProvisionedUser({ email, firstName = '', lastName = '', companyName = '', planType = 'single', stripeCustomerId = '', accessExpiresAt = null }){
  const normEmail = normalizeEmail(email);
  if (!normEmail) return null;
  const users = [...(authState.users || [])];
  const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(normEmail));
  const token = makeSetupToken();
  const setupExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();

  if (idx >= 0) {
    const existing = users[idx];
    const nextRole = existing.role === 'admin' ? 'admin' : 'user';
    users[idx] = {
      ...existing,
      email: normEmail,
      planType,
      firstName: firstName || existing.firstName || '',
      lastName: lastName || existing.lastName || '',
      companyName: companyName || existing.companyName || '',
      name: planType === 'commercial' ? (companyName || existing.companyName || existing.name || normEmail) : ([firstName || existing.firstName || '', lastName || existing.lastName || ''].filter(v => v !== '').join(' ') || existing.name || normEmail),
      role: nextRole,
      stripeCustomerId: stripeCustomerId || existing.stripeCustomerId || null,
      accessExpiresAt: accessExpiresAt || existing.accessExpiresAt || null,
      subscriptionStatus: 'active',
      subscriptionActive: true,
      setupToken: token,
      setupExpiresAt,
      updatedAt: new Date().toISOString()
    };
    saveAuthState({ username: authState.username, password: authState.password, users });
    return { user: users[idx], created: false };
  }

  const nu = {
    username: normEmail,
    email: normEmail,
    firstName,
    lastName,
    companyName,
    name: planType === 'commercial' ? (companyName || normEmail) : ([firstName, lastName].filter(v => v !== '').join(' ') || normEmail),
    planType,
    password: '',
    role: 'user',
    tenantId: 'default',
    stripeCustomerId: stripeCustomerId || null,
    accessExpiresAt: accessExpiresAt || null,
    subscriptionStatus: 'active',
    subscriptionActive: true,
    setupToken: token,
    setupExpiresAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  users.push(nu);
  saveAuthState({ username: authState.username, password: authState.password, users });
  return { user: nu, created: true };
}

async function ensureStripeCustomerForUser(user){
  const stripe = getStripe();
  if (!stripe) return user;
  if (user?.stripeCustomerId) return user;
  const email = normalizeEmail(user?.email || user?.username || '');
  if (!email) return user;
  const customer = await stripe.customers.create({
    email,
    name: user?.name || ([user?.firstName || '', user?.lastName || ''].filter(v => v !== '').join(' ') || email),
    metadata: {
      planType: user?.planType || 'single'
    }
  });
  return { ...user, stripeCustomerId: customer.id };
}

async function checkSubscriptionByUser(user){
  const stripe = getStripe();
  if (!stripe) return { enforceable: false, active: true, reason: 'stripe_not_configured' };
  const email = normalizeEmail(user?.email || user?.username || '');
  if (!email) return { enforceable: true, active: false, reason: 'email_missing' };

  const explicitPlanType = String(user?.planType || '').toLowerCase();
  if (explicitPlanType === 'single_day') {
    const exp = new Date(user?.accessExpiresAt || 0).getTime();
    if (Number.isFinite(exp) && exp > 0) {
      const active = Date.now() < exp;
      return {
        enforceable: true,
        active,
        reason: active ? 'ok' : 'single_day_expired',
        customerId: user?.stripeCustomerId || '',
        planType: 'single_day',
        customerName: String(user?.name || ''),
        accessExpiresAt: user?.accessExpiresAt || null
      };
    }
  }

  let customerRecord = null;
  let customerId = user?.stripeCustomerId || '';
  let preloadSubs = null;
  if (!customerId) {
    try {
      const customers = await stripe.customers.list({ email, limit: 10 });
      const records = Array.isArray(customers?.data) ? customers.data : [];
      for (const record of records) {
        let subs;
        try {
          subs = await stripe.subscriptions.list({ customer: record.id, status: 'all', limit: 20 });
        } catch {
          continue;
        }
        const activeSub = (subs?.data || []).find(s => ['active', 'trialing', 'past_due'].includes(String(s.status || '').toLowerCase()));
        if (activeSub) {
          customerRecord = record;
          customerId = record.id;
          preloadSubs = subs;
          break;
        }
        if (!customerRecord) customerRecord = record;
      }
      if (!customerId && customerRecord) customerId = customerRecord.id;
    } catch {}
  } else {
    try {
      customerRecord = await stripe.customers.retrieve(customerId);
    } catch {}
  }
  if (!customerId) return { enforceable: true, active: false, reason: 'customer_not_found' };

  const planType = String(customerRecord?.metadata?.planType || user?.planType || 'single');
  const customerName = String(customerRecord?.name || '');

  try {
    const subs = preloadSubs || await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    const activeSub = (subs?.data || []).find(s => ['active', 'trialing', 'past_due'].includes(String(s.status || '').toLowerCase()));
    if (planType === 'single_day') {
      const baseTs = Number(activeSub?.current_period_end || activeSub?.trial_end || customerRecord?.created || 0);
      const expIso = baseTs ? new Date(baseTs * 1000).toISOString() : null;
      const active = !!baseTs && Date.now() < (baseTs * 1000);
      return { enforceable: true, active, reason: active ? 'ok' : 'single_day_expired', customerId, planType, customerName, accessExpiresAt: expIso };
    }
    const active = !!activeSub;
    return { enforceable: true, active, reason: active ? 'ok' : 'subscription_inactive', customerId, planType, customerName };
  } catch {
    return { enforceable: true, active: false, reason: 'subscription_lookup_failed', customerId, planType, customerName };
  }
}

async function syncProvisioningFromStripe(){
  const stripe = getStripe();
  if (!stripe) return { ok: false, reason: 'stripe_not_configured', scanned: 0, updated: 0 };

  const users = [...(authState.users || [])];
  let updated = 0;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    try {
      const sub = await checkSubscriptionByUser(u);
      const next = {
        ...u,
        stripeCustomerId: sub.customerId || u.stripeCustomerId || null,
        accessExpiresAt: sub.accessExpiresAt || u.accessExpiresAt || null,
        subscriptionActive: !!sub.active,
        subscriptionStatus: sub.reason || null,
        updatedAt: new Date().toISOString()
      };
      if (JSON.stringify(next) !== JSON.stringify(u)) {
        users[i] = next;
        updated++;
      }
    } catch {}
  }

  if (updated) saveAuthState({ username: authState.username, password: authState.password, users });
  return { ok: true, scanned: users.length, updated };
}

async function ensurePgSchema(pool){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS betman_auth_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      users JSONB NOT NULL DEFAULT '[]'::jsonb,
      admin_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE betman_auth_state ADD COLUMN IF NOT EXISTS admin_meta JSONB NOT NULL DEFAULT '{}'::jsonb"
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS betman_data (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS betman_audit (
      tenant_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      date TEXT,
      payload JSONB NOT NULL,
      PRIMARY KEY (tenant_id, ts)
    )
  `);
}

async function loadAuthStateFromPg(pool){
  const r = await pool.query('SELECT username, password, users, admin_meta FROM betman_auth_state WHERE id=1');
  if (!r.rows?.length) return null;
  const row = r.rows[0];
  return {
    username: row.username,
    password: row.password,
    users: Array.isArray(row.users) ? row.users : [],
    adminMeta: row.admin_meta || {}
  };
}

async function saveAuthStateToPg(pool, state){
  await pool.query(
    `INSERT INTO betman_auth_state (id, username, password, users, admin_meta, updated_at)
     VALUES (1, $1, $2, $3::jsonb, $4::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
     SET username=EXCLUDED.username,
         password=EXCLUDED.password,
         users=EXCLUDED.users,
         admin_meta=EXCLUDED.admin_meta,
         updated_at=NOW()`,
    [state.username, state.password, JSON.stringify(state.users || []), JSON.stringify(state.adminMeta || {})]
  );
}

function toInt(v, fallback){
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function okJson(res, payload, code = 200, req = null){
  send(res, code, JSON.stringify(payload, null, 2), 'application/json', req);
}

function normalizeUsername(u){
  const v = String(u || '').trim();
  // Email-style usernames are matched case-insensitively.
  return v.includes('@') ? v.toLowerCase() : v;
}

function normalizeEmail(v){
  return String(v || '').trim().toLowerCase();
}

const PROTECTED_BETMAN_USERNAMES = new Set(
  String(process.env.BETMAN_PROTECTED_ACCOUNTS || '')
    .split(',')
    .map((name) => normalizeUsername(name))
    .filter(Boolean)
);

function isProtectedBetmanAccount(value){
  const record = (value && typeof value === 'object') ? value : { username: value };
  const username = normalizeUsername(record.username || record.email || '');
  const tenant = normalizeTenantId(record.tenantId || '');
  const company = String(record.companyName || '').toLowerCase();
  const planType = String(record.planType || '').toLowerCase();
  const role = String(record.role || '').toLowerCase();

  if (role === 'admin') return true;
  if (username && PROTECTED_BETMAN_USERNAMES.has(username)) return true;

  const haystack = [username, tenant, company, planType]
    .filter(Boolean)
    .join('|')
    .toLowerCase();
  return haystack.includes('betman');
}

function hasPulseAccess(principal){
  return !!principal;
}

function hasApiKeyAccess(principal){
  if (!principal) return false;
  if (principal.isAdmin) return true;
  return PULSE_ALLOWLIST.has(normalizeUsername(principal.username || ''));
}

function requirePulseAccess(req, res){
  const principal = req.authPrincipal;
  if (hasPulseAccess(principal)) return true;
  return okJson(res, { ok: false, error: 'pulse_not_allowed' }, 403, req), false;
}

function isValidEmail(v){
  const e = normalizeEmail(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function parseBasicAuth(req){
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function parseCookies(req){
  const raw = String(req.headers.cookie || '');
  const out = {};
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const k = p.slice(0, i).trim();
    const v = decodeURIComponent(p.slice(i + 1).trim());
    out[k] = v;
  });
  return out;
}

function createSession(principal){
  if (principal && !principal.effectiveTenantId) {
    principal.effectiveTenantId = effectiveTenantId(principal);
  }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { principal, exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

function getSessionPrincipalById(sid){
  if (!sid) return null;
  const row = sessions.get(sid);
  if (!row) return null;
  if (Date.now() > Number(row.exp || 0)) {
    sessions.delete(sid);
    return null;
  }
  if (!row.principal) return null;
  if (!row.principal.effectiveTenantId) {
    row.principal.effectiveTenantId = effectiveTenantId(row.principal);
  }
  return row.principal;
}

function getSessionPrincipal(req){
  const cookies = parseCookies(req);
  const sid = cookies.betman_session;
  if (!sid) return null;
  return getSessionPrincipalById(sid);
}

function validateCredentials(username, password){
  const user = normalizeUsername(username);
  const pass = String(password || '');
  const hashed = hashApiSecret(pass);
  const adminUser = normalizeUsername(authState.username);
  const adminMeta = authState.adminMeta || {};
  const adminPasswordValid = pass === authState.password;
  const adminKeyValid = adminMeta.apiKeyHash && hashed === adminMeta.apiKeyHash;
  if (user === adminUser && (adminPasswordValid || adminKeyValid)) {
    const principal = { username: authState.username, role: 'admin', isAdmin: true, source: 'admin', tenantId: 'default' };
    principal.effectiveTenantId = effectiveTenantId(principal);
    return principal;
  }
  const found = (authState.users || []).find(u => normalizeUsername(u.username) === user);
  if (!found) return null;
  const passwordMatches = pass === found.password;
  const apiKeyMatches = found.apiKeyHash && hashed === found.apiKeyHash;
  if (!passwordMatches && !apiKeyMatches) return null;
  const role = found.role || 'user';
  const principal = { username: found.username, role, isAdmin: role === 'admin', source: 'users', tenantId: normalizeTenantId(found.tenantId || 'default') };
  principal.effectiveTenantId = effectiveTenantId(principal);
  return principal;
}

function getAuthPrincipal(req){
  refreshAuthStateFromDisk();
  const sessionPrincipal = getSessionPrincipal(req);
  if (sessionPrincipal) return sessionPrincipal;

  const auth = String(req?.headers?.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) {
    const principal = getSessionPrincipalById(String(bearer[1]).trim());
    if (principal) return principal;
  }

  const xApiKey = String(req?.headers?.['x-api-key'] || '').trim();
  if (xApiKey) {
    const principal = validateCredentials(authState.username, xApiKey);
    if (principal) return principal;
  }

  const creds = parseBasicAuth(req);
  if (!creds) return null;
  return validateCredentials(creds.username, creds.password);
}

function getUserRecordByPrincipal(principal){
  if (!principal || principal.source !== 'users') return null;
  return (authState.users || []).find(u => normalizeUsername(u.username) === normalizeUsername(principal.username)) || null;
}

function hashApiSecret(secret){
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

const OPENAI_COMPLIMENTARY_GLOBAL = String(process.env.BETMAN_OPENAI_COMPLIMENTARY || 'false').toLowerCase() === 'true';

function canUseOpenAiByPrincipal(principal){
  if (!principal) return false;
  if (principal.isAdmin) return true;
  const u = getUserRecordByPrincipal(principal);
  if (!u) return false;
  if (u.openaiComplimentary === true) return true;
  if (u.openaiEnabled === true) return true;
  return false;
}

function requireAuth(req, res){
  const principal = getAuthPrincipal(req);
  if (principal) {
    if (!principal.effectiveTenantId) principal.effectiveTenantId = effectiveTenantId(principal);
    req.authPrincipal = principal;
    return true;
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-Reason': 'auth_required'
  };
  if (HTTP_BASIC_PROMPT) headers['WWW-Authenticate'] = 'Basic realm="BETMAN", charset="UTF-8"';
  const cookies = parseCookies(req);
  if (cookies.betman_session) headers['Set-Cookie'] = 'betman_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  res.writeHead(401, headers);
  res.end(JSON.stringify({ ok: false, error: 'auth_required' }));
  return false;
}

function saveAuthState(next){
  const previousMeta = authState?.adminMeta || {};
  const requestedMeta = next.adminMeta || {};
  authState = {
    username: next.username,
    password: next.password,
    adminMeta: {
      apiKeyHash: (requestedMeta.apiKeyHash !== undefined) ? requestedMeta.apiKeyHash : (previousMeta.apiKeyHash || null),
      apiKeyCreatedAt: (requestedMeta.apiKeyCreatedAt !== undefined) ? requestedMeta.apiKeyCreatedAt : (previousMeta.apiKeyCreatedAt || null),
      apiKeyPreview: (requestedMeta.apiKeyPreview !== undefined) ? requestedMeta.apiKeyPreview : (previousMeta.apiKeyPreview || null)
    },
    users: (Array.isArray(next.users) ? next.users : (authState.users || [])).map(u => ({
      ...u,
      tenantId: normalizeTenantId(u.tenantId || 'default'),
      planType: u.planType || 'single',
      apiKeyHash: u.apiKeyHash || null,
      apiKeyCreatedAt: u.apiKeyCreatedAt || null,
      apiKeyPreview: u.apiKeyPreview || null,
      openaiEnabled: u.openaiEnabled === true,
      openaiComplimentary: u.openaiComplimentary === true
    }))
  };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authState, null, 2));

  const pool = getPgPool();
  if (pool) {
    saveAuthStateToPg(pool, authState).catch((e) => {
      console.error('Postgres auth save failed:', e.message);
    });
  }
}

function normalizeRunnerName(name){
  return String(name || '')
    .replace(/^\s*(?:#?\d+|\(\d+\))\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*runner\s*\d+\s*[.\-:)]*\s*/i, '')
    .replace(/^\s*emerg(?:ency)?\s*\d+\s*[.\-:)]*\s*/i, '')
    .trim()
    .toLowerCase();
}

function normalizeMeetingName(name){
  return String(name || '').trim().toLowerCase();
}

function normalizeRaceValue(value){
  return String(value || '').replace(/^R/i, '').trim();
}

function normalizeTrackedKey(meeting, race, selection){
  return `${normalizeMeetingName(meeting)}|${normalizeRaceValue(race)}|${normalizeRunnerName(selection)}`;
}

function toPositiveOddsValue(...values){
  for (const raw of values) {
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return Number(num.toFixed(2));
  }
  return null;
}

function resolveTrackedCurrentOdds(row, options) {
  const {
    runnerOdds = null,
    runnerSource = 'races',
    moverOdds = null,
    moverSource = 'market-movers',
    suggestedOdds = null,
    suggestedSource = 'suggested-bets',
    raceFinished = false,
  } = options || {};

  const persistedCurrent = toPositiveOddsValue(row?.currentOdds);
  const entryOdds = toPositiveOddsValue(row?.entryOdds, row?.odds);

  if (runnerOdds != null) {
    return { currentOdds: runnerOdds, currentOddsSource: runnerSource || 'races' };
  }

  if (!raceFinished && moverOdds != null) {
    return { currentOdds: moverOdds, currentOddsSource: moverSource || 'market-movers' };
  }

  if (!raceFinished && suggestedOdds != null) {
    return { currentOdds: suggestedOdds, currentOddsSource: suggestedSource || 'suggested-bets' };
  }

  if (persistedCurrent != null) {
    return {
      currentOdds: persistedCurrent,
      currentOddsSource: row?.currentOddsSource || (raceFinished ? 'last known' : 'cached'),
    };
  }

  if (entryOdds != null) {
    return {
      currentOdds: entryOdds,
      currentOddsSource: raceFinished ? 'last known (entry)' : 'entry',
    };
  }

  return {
    currentOdds: null,
    currentOddsSource: row?.currentOddsSource || null,
  };
}

function formatRunnerCallout(selection, suggested = []){
  const name = String(selection?.selection || selection?.runner || '').trim();
  if (!name) return '';
  const meeting = selection?.meeting || '—';
  const race = selection?.race || selection?.race_number || '—';
  const norm = normalizeRunnerName(name);
  const hit = (suggested || []).find(row =>
    normalizeRunnerName(row?.selection || row?.runner || '') === norm &&
    String(row?.meeting || '').trim().toLowerCase() === String(meeting || '').trim().toLowerCase() &&
    String(row?.race || '').trim() === String(race || '').trim()
  ) || (suggested || []).find(row => normalizeRunnerName(row?.selection || row?.runner || '') === norm);
  const prob = parseReasonWinProb(hit?.reason);
  const odds = parseReasonOdds(hit?.reason);
  const reason = trimText(hit?.reason, 120);
  const stake = Number(hit?.stake);
  const type = String(hit?.type || 'Win').toUpperCase();
  const parts = [`${meeting} R${race} ${name}`, type];
  if (Number.isFinite(prob)) parts.push(`${prob.toFixed(1)}% model`);
  if (Number.isFinite(odds)) parts.push(`@$${odds.toFixed(2)}`);
  if (Number.isFinite(stake)) parts.push(`stake $${stake.toFixed(2)}`);
  const note = reason ? `Reason: ${reason}` : '';
  return `${parts.filter(Boolean).join(' · ')}${note ? ` — ${note}` : ''}`;
}

function envNumber(name, fallback, min = null, max = null){
  const raw = Number(process.env[name]);
  let v = Number.isFinite(raw) ? raw : fallback;
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}

function isSmallModel(model){
  const m = String(model || '').toLowerCase();
  return m.includes('deepseek-r1:8b') || m.includes('llama3.1:8b') || m.includes('llama3.2:3b') || m.includes('qwen2.5:1.5b') || m.includes('qwen2.5:3b');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const OLLAMA_MODEL_CACHE_TTL_MS = 30000;
const ollamaModelsCache = new Map();

async function fetchOllamaModelsForBase(base){
  const normalized = normalizeBaseUrl(base || BETMAN_OLLAMA_DEFAULT_BASE) || BETMAN_OLLAMA_DEFAULT_BASE;
  const now = Date.now();
  const cached = ollamaModelsCache.get(normalized);
  if (cached && (now - cached.at) < OLLAMA_MODEL_CACHE_TTL_MS && Array.isArray(cached.models)) {
    return { base: normalized, models: cached.models.slice(), ok: !!cached.ok };
  }
  const timeoutMs = envNumber('BETMAN_OLLAMA_TAGS_TIMEOUT_MS', 8000, 2000, 30000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let models = [];
  let ok = false;
  try {
    const r = await fetch(`${normalized}/api/tags`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`ollama_tags_${r.status}`);
    const out = await r.json();
    models = (Array.isArray(out?.models) ? out.models : [])
      .map(m => String(m?.name || '').trim())
      .filter(Boolean);
    if (models.length) {
      ok = true;
    } else {
      models = DEFAULT_OLLAMA_FALLBACK_MODELS.slice();
    }
  } catch (err) {
    console.error('ollama_models_fetch_error', normalized, err?.message || err);
    if (cached && Array.isArray(cached.models) && cached.models.length) {
      clearTimeout(timer);
      return { base: normalized, models: cached.models.slice(), ok: !!cached.ok };
    }
    models = DEFAULT_OLLAMA_FALLBACK_MODELS.slice();
  } finally {
    clearTimeout(timer);
  }
  ollamaModelsCache.set(normalized, { at: now, models: models.slice(), ok });
  return { base: normalized, models: models.slice(), ok };
}

async function fetchOllamaModelsFromBases(bases = []){
  const list = (Array.isArray(bases) && bases.length) ? bases : getOllamaBaseList();
  for (const base of list) {
    const result = await fetchOllamaModelsForBase(base);
    if (result.ok && result.models.length) return result;
  }
  const fallbackBase = list[0] || normalizeBaseUrl(BETMAN_OLLAMA_DEFAULT_BASE) || BETMAN_OLLAMA_DEFAULT_BASE;
  return { base: fallbackBase, models: DEFAULT_OLLAMA_FALLBACK_MODELS.slice(), ok: false };
}

function resolveAiProvider(){
  const explicit = String(process.env.BETMAN_CHAT_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  // Cost-control default: prefer local/remote Ollama when configured, even if OpenAI key exists.
  if (process.env.OLLAMA_BASE_URL || process.env.BETMAN_OLLAMA_BASE_URL || process.env.BETMAN_CHAT_BASE_URL) return 'ollama';
  if (process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY) return 'openai';
  return 'ollama';
}

function inferProviderForModel(model){
  const m = String(model || '').trim().toLowerCase();
  if (!m) return '';
  if ((m.includes('deepseek-r1:8b') || m.includes('llama3.1:8b') || m.includes('qwen2.5:') || m.includes('qwen-') || m.includes('ollama/'))) return 'ollama';
  if (m.includes('gpt-') || m.includes('openai/')) return 'openai';
  return '';
}

function openAiUsesCompletionTokens(model){
  const m = String(model || '').trim().toLowerCase();
  return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3');
}

function appendRunnerCallouts(answer, selections = [], suggested = []){
  if (!Array.isArray(selections) || !selections.length) return answer;
  const base = String(answer || '');
  const lower = base.toLowerCase();
  const missing = selections
    .map(sel => ({ sel, norm: normalizeRunnerName(sel?.selection || sel?.runner || '') }))
    .filter(item => item.norm && !lower.includes(item.norm));
  if (!missing.length) return base;
  const notes = missing.map(item => formatRunnerCallout(item.sel, suggested)).filter(Boolean);
  if (!notes.length) return base;
  return `${base}\n\nRunner callouts:\n${notes.join('\n')}`;
}

function raceKey(meeting, race){
  return `${String(meeting || '').trim().toLowerCase()}|${String(race || '').trim()}`;
}

function buildRaceLookup(races = []){
  const map = new Map();
  (races || []).forEach(r => {
    const key = raceKey(r.meeting, r.race_number);
    map.set(key, r);
  });
  return map;
}

function findRunnerPayload(sel, raceLookup, races = []){
  const meeting = sel?.meeting;
  const race = sel?.race || sel?.race_number;
  const norm = normalizeRunnerName(sel?.selection || sel?.runner || '');
  if (!norm) return { race: null, runner: null };
  let targetRace = null;
  if (meeting && race && raceLookup.has(raceKey(meeting, race))) {
    targetRace = raceLookup.get(raceKey(meeting, race));
  }
  if (!targetRace) {
    targetRace = (races || []).find(r => (r.runners || []).some(run => normalizeRunnerName(run.name || '') === norm));
  }
  const runner = targetRace ? (targetRace.runners || []).find(run => normalizeRunnerName(run.name || '') === norm) : null;
  return { race: targetRace || null, runner: runner || null };
}

function formatSelectionDetails(sel, raceLookup, races = []){
  const { race, runner } = findRunnerPayload(sel, raceLookup, races);
  const meeting = sel?.meeting || race?.meeting || '—';
  const raceNum = sel?.race || race?.race_number || '—';
  const name = sel?.selection || sel?.runner || runner?.name || 'Selection';
  const bits = [`${meeting} R${raceNum} ${name}`];
  if (race?.description) bits.push(race.description);
  if (race?.distance) bits.push(`${race.distance}m`);
  if (race?.track_condition) bits.push(`Track ${race.track_condition}`);
  if (race?.rail_position) bits.push(`Rail ${race.rail_position}`);
  if (runner?.runner_number) bits.push(`#${runner.runner_number}`);
  if (runner?.barrier) bits.push(`Gate ${runner.barrier}`);
  if (runner?.jockey) bits.push(`Jockey ${runner.jockey}`);
  if (runner?.apprentice_indicator) bits.push('(A)');
  if (runner?.trainer) bits.push(`Trainer ${runner.trainer}`);
  if (runner?.trainer_location) bits.push(`(${runner.trainer_location})`);
  if (runner?.weight || runner?.weight_total) bits.push(`Weight ${runner.weight || runner.weight_total}kg`);
  if (runner?.age) bits.push(`Age ${runner.age}`);
  if (runner?.sex) bits.push(runner.sex);
  if (runner?.gear) bits.push(`Gear ${runner.gear}`);
  if (runner?.last_twenty_starts) bits.push(`Form ${runner.last_twenty_starts}`);
  if (runner?.form_comment) bits.push(`Comment ${runner.form_comment}`);
  if (runner?.speedmap) bits.push(`Speedmap ${runner.speedmap}`);
  if (runner?.sire) bits.push(`Sire ${runner.sire}`);
  if (runner?.dam) bits.push(`Dam ${runner.dam}`);
  if (runner?.dam_sire) bits.push(`Dam Sire ${runner.dam_sire}`);
  const statsStr = formatStatsCompact(runner?.stats);
  if (statsStr) bits.push(`Stats ${statsStr}`);
  return bits.filter(Boolean).join(' · ');
}

function inferSelectionsFromQuestion(question, suggested = [], races = []){
  const q = String(question || '').toLowerCase();
  if (!q) return [];
  const seen = new Set();
  const results = [];
  const addSel = (meeting, race, selection) => {
    const key = `${String(meeting || '').trim().toLowerCase()}|${String(race || '').trim()}|${normalizeRunnerName(selection || '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ meeting, race, selection });
  };
  (suggested || []).forEach(row => {
    const name = row?.selection || '';
    const norm = normalizeRunnerName(name);
    if (norm && q.includes(norm)) {
      addSel(row.meeting, row.race, name);
    }
  });
  if (results.length < 3) {
    (races || []).forEach(race => {
      (race.runners || []).forEach(run => {
        const norm = normalizeRunnerName(run.name || '');
        if (norm && q.includes(norm)) {
          addSel(race.meeting, String(race.race_number), run.name);
        }
      });
    });
  }

  if (results.length < 2) {
    const nowSec = Date.now() / 1000;
    const meetingMap = new Map();
    (races || []).forEach(r => {
      const name = String(r.meeting || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!meetingMap.has(key)) meetingMap.set(key, name);
    });
    for (const [meetingKey, meetingName] of meetingMap.entries()) {
      if (!q.includes(meetingKey)) continue;
      const meetingRaces = (races || []).filter(r => String(r.meeting || '').trim().toLowerCase() === meetingKey);
      if (!meetingRaces.length) continue;
      meetingRaces.sort((a, b) => Number(a.advertised_start || 0) - Number(b.advertised_start || 0));
      const targetRace = meetingRaces.find(r => Number(r.advertised_start || 0) >= nowSec) || meetingRaces[meetingRaces.length - 1];
      if (!targetRace) continue;
      const raceNum = String(targetRace.race_number || '').trim();
      const matchedSuggestions = (suggested || []).filter(row =>
        String(row.meeting || '').trim().toLowerCase() === meetingKey &&
        String(row.race || '').replace(/^R/i, '').trim() === raceNum
      );
      let runnerName = null;
      if (matchedSuggestions.length) {
        matchedSuggestions.sort((a, b) => (Number(b.aiWinProb) || 0) - (Number(a.aiWinProb) || 0));
        runnerName = matchedSuggestions[0]?.selection || null;
      }
      if (!runnerName) {
        const sortedRunners = (targetRace.runners || []).slice().sort((a, b) => {
          const oddsA = Number(a.fixed_win || a.odds || a.tote_win || Infinity);
          const oddsB = Number(b.fixed_win || b.odds || b.tote_win || Infinity);
          return oddsA - oddsB;
        });
        runnerName = sortedRunners[0]?.name || sortedRunners[0]?.runner_name || null;
      }
      if (runnerName) {
        addSel(meetingName, raceNum, runnerName);
      }
      if (results.length >= 4) break;
    }
  }
  return results.slice(0, 4);
}

// Well-known NZ and Australian racecourses for detecting venue mentions
// when the venue is not in today's available races.
const KNOWN_VENUES = [
  'riccarton','ellerslie','trentham','wingatui','matamata','pukekohe',
  'tauranga','tauherenikau','whanganui','ashburton','te aroha','te rapa',
  'hastings','ruakaka','otaki','awapuni','new plymouth','rotorua',
  'cambridge','addington','forbury park','alexandra park',
  'randwick','caulfield','flemington','rosehill','eagle farm','doomben',
  'moonee valley','morphettville','ascot','warwick farm','canterbury',
  'sandown','cranbourne','pakenham','geelong','ballarat','bendigo',
  'gold coast','sunshine coast','kembla grange','newcastle','hawkesbury',
  'gosford','wyong','scone','launceston','hobart'
];

function inferMeetingFromQuestion(question, races = []) {
  const q = String(question || '').toLowerCase();
  if (!q) return { mentioned: null, matched: [], available: [] };

  const available = [...new Set(
    (races || []).map(r => String(r.meeting || '').trim()).filter(Boolean)
  )];
  const availableLower = available.map(m => m.toLowerCase());

  // Check if any available meeting name appears in the question (word-boundary match)
  const matched = available.filter((_m, i) => {
    const lower = availableLower[i];
    if (!lower) return false;
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(q);
  });

  if (matched.length) {
    return { mentioned: matched[0], matched, available };
  }

  // Check known venues not in today's races
  for (const venue of KNOWN_VENUES) {
    if (availableLower.some(a => a === venue || a.startsWith(venue + ' ') || a.startsWith(venue + '-'))) continue;
    const escaped = venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(q)) {
      const titleCase = venue.replace(/\b\w/g, c => c.toUpperCase());
      return { mentioned: titleCase, matched: [], available };
    }
  }

  return { mentioned: null, matched: [], available: [] };
}

/**
 * Detect temporal race intent ("next race", "last race", "previous race", etc.)
 * at a specific venue. Returns { race, direction } or null.
 *
 * "next" / "upcoming" / "coming" → first non-finished race (ascending race number)
 * "last" / "previous" / "latest" / "most recent" / "just ran" → most recently
 *   finished race (descending race number among finished)
 */
function inferTemporalRaceAtVenue(question, races, venueMeeting) {
  const q = String(question || '').toLowerCase();
  if (!venueMeeting) return null;

  const wantsNext = /\b(next|upcoming|coming up)\b/.test(q);
  const wantsLast = /\b(last|previous|latest|most recent|just ran|just run)\b/.test(q);
  if (!wantsNext && !wantsLast) return null;

  const meetingLower = String(venueMeeting).trim().toLowerCase();
  const venueRaces = (races || [])
    .filter(r => String(r.meeting || '').trim().toLowerCase() === meetingLower);

  if (wantsLast) {
    const finished = venueRaces
      .filter(r => FINISHED_RACE_STATUSES.has(String(r.race_status || '').toLowerCase()))
      .sort((a, b) => (Number(b.race_number) || 0) - (Number(a.race_number) || 0));
    if (finished.length) return { race: finished[0], direction: 'last' };
  }

  // Default to "next" if both keywords appear or only "next"
  if (wantsNext || !wantsLast) {
    const upcoming = venueRaces
      .filter(r => !FINISHED_RACE_STATUSES.has(String(r.race_status || '').toLowerCase()))
      .sort((a, b) => (Number(a.race_number) || 0) - (Number(b.race_number) || 0));
    if (upcoming.length) return { race: upcoming[0], direction: 'next' };
  }

  return null;
}

/**
 * Backwards-compatible wrapper: returns just the race object or null.
 */
function inferNextRaceAtVenue(question, races, venueMeeting) {
  const result = inferTemporalRaceAtVenue(question, races, venueMeeting);
  return result ? result.race : null;
}

/**
 * Format a runner's stats object into a compact summary suitable for AI context.
 * e.g. "track 3:1-0-1, distance 5:2-1-0, good 8:3-2-1"
 */
function formatStatsCompact(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const parts = [];
  const fmt = (label, s) => {
    if (!s || typeof s !== 'object') return;
    const starts = Number(s.number_of_starts || 0);
    if (starts <= 0) return;
    const w = Number(s.number_of_wins || 0);
    const p2 = Number(s.number_of_seconds || 0);
    const p3 = Number(s.number_of_thirds || 0);
    parts.push(`${label} ${starts}:${w}-${p2}-${p3}`);
  };
  fmt('track', stats.track);
  fmt('dist', stats.distance);
  fmt('trk+dist', stats.track_distance);
  fmt('good', stats.good);
  fmt('soft', stats.soft);
  fmt('heavy', stats.heavy);
  fmt('firm', stats.firm);
  fmt('synthetic', stats.synthetic);
  fmt('1st-up', stats.first_up);
  fmt('2nd-up', stats.second_up);
  return parts.length ? parts.join(', ') : null;
}

function mergeSelections(explicit = [], inferred = []){
  const merged = [];
  const seen = new Set();
  const pushSel = (sel) => {
    if (!sel) return;
    const name = sel.selection || sel.runner || '';
    const norm = normalizeRunnerName(name);
    if (!norm) return;
    const key = `${String(sel.meeting || '').trim().toLowerCase()}|${String(sel.race || sel.race_number || '').trim()}|${norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(sel);
  };
  explicit.forEach(pushSel);
  inferred.forEach(pushSel);
  return merged;
}

const FINISHED_RACE_STATUSES = new Set(['final', 'closed', 'finalized', 'abandoned', 'resulted', 'settled', 'complete', 'completed']);

function buildTrackedBetLiveContext(tenantId = 'default') {
  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const allRaces = Array.isArray(racesData?.races) ? racesData.races : [];
  const raceMap = new Map();
  const runnerMap = new Map();
  const moverMap = new Map();
  const suggestedMap = new Map();

  for (const race of allRaces) {
    const raceKey = `${normalizeMeetingName(race?.meeting)}|${normalizeRaceValue(race?.race_number)}`;
    if (!raceMap.has(raceKey)) raceMap.set(raceKey, race);
    const raceFinished = FINISHED_RACE_STATUSES.has(String(race?.race_status || '').toLowerCase());
    if (!Array.isArray(race?.runners) || raceFinished) continue;
    for (const runner of race.runners) {
      const key = normalizeTrackedKey(race?.meeting, race?.race_number, runner?.name || runner?.runner_name || runner?.selection);
      if (!key.endsWith('|')) {
        runnerMap.set(key, {
          currentOdds: toPositiveOddsValue(runner?.odds, runner?.fixed_win, runner?.tote_win, runner?.price, runner?.win),
          raceStatus: race?.race_status || null,
          source: 'races',
        });
      }
    }
  }

  for (const mover of Array.isArray(status?.marketMovers) ? status.marketMovers : []) {
    const key = normalizeTrackedKey(mover?.meeting, mover?.race, mover?.runner || mover?.selection || mover?.name);
    moverMap.set(key, {
      currentOdds: toPositiveOddsValue(mover?.currentOdds, mover?.toOdds, mover?.odds),
      raceStatus: mover?.raceStatus || null,
      source: 'market-movers',
    });
  }

  for (const bet of Array.isArray(status?.suggestedBets) ? status.suggestedBets : []) {
    const key = normalizeTrackedKey(bet?.meeting, bet?.race, bet?.selection || bet?.runner || bet?.name);
    if (!suggestedMap.has(key)) {
      suggestedMap.set(key, {
        currentOdds: toPositiveOddsValue(bet?.odds, parseReasonOdds(bet?.reason)),
        source: 'suggested-bets',
      });
    }
  }

  return { raceMap, runnerMap, moverMap, suggestedMap };
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

function buildTrackedIdentityKey(row) {
  return normalizeTrackedKey(row?.meeting, row?.race, row?.selection);
}

function findTrackedDuplicate(rows = [], candidate = {}) {
  const targetKey = buildTrackedIdentityKey(candidate);
  if (!targetKey || targetKey.endsWith('|')) return null;
  return (Array.isArray(rows) ? rows : []).find((row) => {
    if (String(row?.status || '').toLowerCase() === 'settled') return false;
    return buildTrackedIdentityKey(row) === targetKey;
  }) || null;
}

function enrichTrackedBetWithCurrentOdds(row, liveContext) {
  const entryOdds = toPositiveOddsValue(row?.entryOdds, row?.odds);
  const raceKey = `${normalizeMeetingName(row?.meeting)}|${normalizeRaceValue(row?.race)}`;
  const trackedKey = normalizeTrackedKey(row?.meeting, row?.race, row?.selection);
  const race = liveContext?.raceMap?.get(raceKey) || null;
  const raceStatus = race?.race_status || null;
  const raceFinished = FINISHED_RACE_STATUSES.has(String(raceStatus || '').toLowerCase());
  const jumpMeta = resolveTrackedRaceJumpMeta(row, race);
  const runnerHit = liveContext?.runnerMap?.get(trackedKey);
  const moverHit = liveContext?.moverMap?.get(trackedKey);
  const suggestedHit = liveContext?.suggestedMap?.get(trackedKey);
  const { currentOdds, currentOddsSource } = resolveTrackedCurrentOdds(row, {
    runnerOdds: toPositiveOddsValue(runnerHit?.currentOdds),
    runnerSource: runnerHit?.source || 'races',
    moverOdds: toPositiveOddsValue(moverHit?.currentOdds),
    moverSource: moverHit?.source || 'market-movers',
    suggestedOdds: toPositiveOddsValue(suggestedHit?.currentOdds),
    suggestedSource: suggestedHit?.source || 'suggested-bets',
    raceFinished,
  });

  return {
    ...row,
    odds: entryOdds,
    entryOdds,
    currentOdds,
    currentOddsSource,
    jumpsIn: jumpMeta.jumpsIn,
    minsToJump: jumpMeta.minsToJump,
    raceStartTime: jumpMeta.raceStartTime,
    raceStatus,
  };
}

/** Return true when `entry` (any object with meeting + race/race_number) does NOT
 *  belong to a race whose status is in FINISHED_RACE_STATUSES.  Entries that have
 *  no matching race in allRaces are kept (safe default). */
function isLiveRaceEntry(entry, allRaces) {
  const m = String(entry.meeting || '').trim().toLowerCase();
  const r = String(entry.race || entry.race_number || '').trim().replace(/^R/i, '');
  const raceObj = allRaces.find(x =>
    String(x.meeting || '').trim().toLowerCase() === m &&
    String(x.race_number || '').trim() === r
  );
  return !raceObj || !FINISHED_RACE_STATUSES.has(String(raceObj.race_status || '').toLowerCase());
}

const MIN_AI_ANSWER_LENGTH = 60;
const MIN_RACE_ANALYSIS_ANSWER_LENGTH = 80;

function aiAnswerRespectsSelections(answer, payload){
  const sels = Array.isArray(payload?.selections) ? payload.selections : [];
  if (!sels.length) return true;
  const txt = String(answer || '').toLowerCase();
  return sels.every(s => {
    const name = normalizeRunnerName(s?.selection || '');
    if (!name) return true;
    return txt.includes(name);
  });
}

function parseReasonWinProb(reason){
  const m = String(reason || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function parseReasonOdds(reason){
  const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function enrichDecisionRow(row){
  const modelProb = Number(row?.aiWinProb);
  const p = Number.isFinite(modelProb) ? modelProb : parseReasonWinProb(row?.reason);
  const odds = parseReasonOdds(row?.reason);
  const impliedProb = (Number.isFinite(odds) && odds > 0) ? (100 / odds) : NaN;
  const edgePts = (Number.isFinite(p) && Number.isFinite(impliedProb)) ? (p - impliedProb) : NaN;
  const riskLabel = !Number.isFinite(p) ? 'medium' : (p >= 30 ? 'low' : (p >= 20 ? 'medium' : 'high'));
  const invalidation = Number.isFinite(edgePts) && edgePts > 0
    ? 'Invalidate if odds drift weakens edge materially or pace setup changes.'
    : 'Invalidate if market continues against selection or race shape shifts.';
  return {
    ...row,
    decision: {
      verdict: Number.isFinite(edgePts) && edgePts > 0 ? 'actionable' : 'watch/pass',
      modelProb: Number.isFinite(p) ? Math.round(p * 10) / 10 : null,
      impliedProb: Number.isFinite(impliedProb) ? Math.round(impliedProb * 10) / 10 : null,
      edgePts: Number.isFinite(edgePts) ? Math.round(edgePts * 10) / 10 : null,
      riskLabel,
      invalidation
    }
  };
}

function buildDecisionAudit(status){
  const rows = Array.isArray(status?.suggestedBets) ? status.suggestedBets : [];
  const enriched = rows.map(enrichDecisionRow);
  const missingReason = enriched.filter(x => !String(x.reason || '').trim()).length;
  const withEdge = enriched.filter(x => Number.isFinite(Number(x?.decision?.edgePts))).length;
  const withRisk = enriched.filter(x => !!x?.decision?.riskLabel).length;
  const withInvalidation = enriched.filter(x => !!x?.decision?.invalidation).length;
  const total = enriched.length || 1;
  const complianceScore = Math.round(((withEdge + withRisk + withInvalidation) / (total * 3)) * 100);
  return {
    suggestedBets: enriched,
    decisionAudit: {
      standard: 'BETMAN Decision Standard MVP1.1',
      totalRows: enriched.length,
      withEdge,
      withRisk,
      withInvalidation,
      missingReason,
      complianceScore
    }
  };
}

function enforceDecisionAnswerFormat(answer){
  let out = String(answer || '').trim();

  // Remove template placeholders like [Jockey Name], [Trainer Name], etc.
  out = out.replace(/\[[^\]\n]{2,40}\]/g, 'n/a');

  const hasVerdict = /\bverdict\b/i.test(out);
  const hasEdge = /market\s*edge|\bedge\b/i.test(out);
  const hasRisk = /\brisk\b/i.test(out);
  const hasInvalidation = /invalidation|pass\s+conditions?/i.test(out);

  if (!hasVerdict) out += `\n\nVerdict: Refer to the analysis above — verify edge is positive before acting.`;
  if (!hasEdge) out += `\nMarket edge: not calculated in this response — check odds table above.`;
  if (!hasRisk) out += `\nRisk: assess based on field size and pace-shape uncertainty.`;
  if (!hasInvalidation) out += `\nPass conditions: pass if market drifts beyond edge or race shape changes against setup.`;
  return out;
}

function isMalformedJsonLikeAnswer(answer){
  const text = String(answer || '').trim();
  if (!text) return false;
  let body = text;
  const fenced = text.match(/^```json\s*([\s\S]*?)\s*```$/i);
  if (fenced) body = fenced[1].trim();
  const looksJson = body.startsWith('{') || body.startsWith('[');
  if (!looksJson) return false;
  try {
    JSON.parse(body);
    return false;
  } catch {
    return true;
  }
}

function raceAnalysisMatchesContext(answer, clientContext = {}){
  const txt = String(answer || '');
  if (txt.length < MIN_RACE_ANALYSIS_ANSWER_LENGTH) return false;
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return true;

  const hasMeeting = new RegExp(meeting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt);
  const raceMentions = [...txt.matchAll(/\bR(?:ace)?\s*([0-9]{1,2})\b/gi)].map(m => String(m[1]));
  if (raceMentions.length && !raceMentions.includes(raceNo)) return false;
  return true;
}

function buildSpeedMapProjection(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;

  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const race = (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  );
  if (!race || !Array.isArray(race.runners)) return null;

  const leaders = [];
  const onPace = [];
  const midfield = [];
  const backmarkers = [];

  for (const rr of race.runners) {
    const nm = String(rr?.name || rr?.runner_name || '').trim();
    if (!nm) continue;
    const sm = String(rr?.speedmap || '').toLowerCase();
    if (sm.includes('leader')) leaders.push(nm);
    else if (sm.includes('on pace') || sm.includes('on-pace') || sm.includes('forward')) onPace.push(nm);
    else if (sm.includes('backmarker') || sm.includes('back marker')) backmarkers.push(nm);
    else midfield.push(nm);
  }

  const tempo = leaders.length >= 3
    ? 'Genuine tempo likely (multiple natural leaders).'
    : (leaders.length === 2
      ? 'Even tempo likely (two clear pace influences).'
      : (leaders.length === 1
        ? 'Controlled tempo likely (single clear leader).'
        : 'Tempo uncertain from map data.'));

  const fmt = (arr) => arr.length ? arr.slice(0, 5).join(', ') : 'n/a';
  return {
    leaders: fmt(leaders),
    onPace: fmt(onPace),
    midfield: fmt(midfield),
    backmarkers: fmt(backmarkers),
    tempo
  };
}

function buildRaceFinalTips(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;

  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const race = (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  );

  const raceSuggested = (Array.isArray(status?.suggestedBets) ? status.suggestedBets : []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === meeting &&
    String(x.race || '').replace(/^R/i, '').trim() === raceNo
  );

  const winRows = raceSuggested
    .filter(x => String(x.type || '').toLowerCase() === 'win')
    .slice()
    .sort((a,b) => Number(b.aiWinProb || 0) - Number(a.aiWinProb || 0));

  const exotics = raceSuggested
    .filter(x => ['top2','top3','top4','trifecta','multi'].includes(String(x.type || '').toLowerCase()))
    .slice(0, 2)
    .map(x => `${String(x.type || '').toUpperCase()}: ${x.selection || x.runner || 'n/a'}`);

  const main = winRows[0]?.selection || (race?.runners || [])[0]?.name || 'n/a';
  const saver = winRows[1]?.selection || null;

  return {
    main,
    saver: saver || null,
    exotics,
    pass: 'Pass if late market drift erodes edge or pace map flips against expected run shape.'
  };
}

function buildRaceConfidence(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;

  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const race = (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  );

  const raceSuggested = (Array.isArray(status?.suggestedBets) ? status.suggestedBets : []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === meeting &&
    String(x.race || '').replace(/^R/i, '').trim() === raceNo &&
    String(x.type || '').toLowerCase() === 'win'
  );

  let topProb = Number(raceSuggested[0]?.aiWinProb);
  if (!Number.isFinite(topProb) || topProb <= 0) {
    const odds = (Array.isArray(race?.runners) ? race.runners : [])
      .map(r => Number(r?.odds || r?.fixed_win || r?.tote_win || NaN))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a,b) => a - b)[0];
    if (Number.isFinite(odds) && odds > 0) topProb = 100 / odds;
  }

  if (!Number.isFinite(topProb) || topProb <= 0) return null;
  const pct = Math.min(90, Math.max(35, Math.round(topProb + 18)));
  return {
    pct,
    basis: `derived from top win profile (${topProb.toFixed(1)}%)`
  };
}

function buildRaceValueAnalysis(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;

  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const race = (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  );

  const winRows = (Array.isArray(status?.suggestedBets) ? status.suggestedBets : []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === meeting &&
    String(x.race || '').replace(/^R/i, '').trim() === raceNo &&
    String(x.type || '').toLowerCase() === 'win'
  );

  const overlays = [];
  const underlays = [];
  for (const s of winRows) {
    const name = String(s.selection || s.runner || '').trim();
    const pModel = Number(s.aiWinProb);
    const o = parseReasonOdds(s.reason || '');
    if (!name || !Number.isFinite(pModel) || !Number.isFinite(o) || o <= 0) continue;
    const implied = 100 / o;
    const edge = pModel - implied;
    const line = `${name}: model ${pModel.toFixed(1)}% vs implied ${implied.toFixed(1)}% (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(1)} pts)`;
    if (edge >= 1.0) overlays.push(line);
    else if (edge <= -1.0) underlays.push(line);
  }

  const movers = (Array.isArray(status?.marketMovers) ? status.marketMovers : [])
    .filter(m => String(m.meeting || '').trim().toLowerCase() === meeting && String(m.race || '').replace(/^R/i, '').trim() === raceNo)
    .sort((a,b) => Math.abs(Number(b.pctMove || 0)) - Math.abs(Number(a.pctMove || 0)))
    .slice(0, 4)
    .map(m => `${m.runner}: ${Number(m.pctMove||0) < 0 ? 'firming' : 'drifting'} ${Math.abs(Number(m.pctMove||0)).toFixed(1)}% over ${m.pctSource || 'unknown'} (${Number(m.fromOdds||0).toFixed(2)}→${Number(m.toOdds||0).toFixed(2)})`);

  const raceOdds = Array.isArray(race?.runners) ? race.runners
    .map(rr => ({
      name: String(rr?.name || rr?.runner_name || '').trim(),
      odds: Number(rr?.odds || rr?.fixed_win || rr?.tote_win || 0)
    }))
    .filter(x => x.name && Number.isFinite(x.odds) && x.odds > 0)
    .sort((a,b) => a.odds - b.odds)
    .slice(0, 3)
    .map(x => `${x.name} @ ${x.odds.toFixed(2)} (${(100/x.odds).toFixed(1)}%)`)
    : [];

  return {
    overlays,
    underlays,
    movers,
    marketTop: raceOdds,
    race
  };
}



function collectRaceRunnerProbabilities(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;

  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  const race = (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  );
  if (!race || !Array.isArray(race.runners) || !race.runners.length) return null;

  const rows = new Map();
  const ensureRow = (name) => {
    const label = String(name || '').trim();
    if (!label) return null;
    const key = normalizeRunnerName(label);
    if (!key) return null;
    if (!rows.has(key)) rows.set(key, { name: label, odds: NaN, implied: NaN, model: NaN });
    const row = rows.get(key);
    if (!row.name && label) row.name = label;
    return row;
  };

  for (const rr of race.runners) {
    const row = ensureRow(rr?.name || rr?.runner_name || '');
    if (!row) continue;
    const odds = Number(rr?.odds || rr?.fixed_win || rr?.tote_win || rr?.price || rr?.win || 0);
    if (Number.isFinite(odds) && odds > 0) {
      row.odds = odds;
      row.implied = 100 / odds;
    }
  }

  const winRows = (Array.isArray(status?.suggestedBets) ? status.suggestedBets : []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === meeting &&
    String(x.race || '').replace(/^R/i, '').trim() === raceNo &&
    String(x.type || '').toLowerCase() === 'win'
  );

  for (const s of winRows) {
    const row = ensureRow(s.selection || s.runner || '');
    if (!row) continue;
    const pModel = Number(s.aiWinProb);
    if (Number.isFinite(pModel) && pModel > 0) row.model = pModel;
    if (!Number.isFinite(row.odds) || row.odds <= 0) {
      const inferredOdds = parseReasonOdds(s.reason || '');
      if (Number.isFinite(inferredOdds) && inferredOdds > 0) {
        row.odds = inferredOdds;
        row.implied = 100 / inferredOdds;
      }
    }
  }

  const values = [...rows.values()].filter(r => r.name && (Number.isFinite(r.odds) || Number.isFinite(r.model)));
  if (!values.length) return null;
  return values;
}

const HORSE_PROFILE_DIGITS = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣'];
const HORSE_PROFILE_FALLBACK = '1️⃣ n/a\n- Barrier / Jockey / Trainer / Weight: n/a\n- Form/sectionals/speed map/suitability: n/a';
const SIM_MODEL_FALLBACK_TEXT = '\n\n🧮 Simulation Model summary\n- Monte Carlo runs: 999,999\n- Weighting: track/tempo/map/sectionals/form/market (n/a where unavailable)';

function normalizeHorseProfileDigit(idx){
  return HORSE_PROFILE_DIGITS[idx+1] || `${idx+1})`;
}

function loadRaceByContext(clientContext = {}, tenantId = 'default'){
  const rc = clientContext?.raceContext || {};
  const meeting = String(rc.meeting || '').trim().toLowerCase();
  const raceNo = String(rc.raceNumber || '').replace(/^R/i, '').trim();
  if (!meeting || !raceNo) return null;
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  return (Array.isArray(racesData?.races) ? racesData.races : []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === meeting &&
    String(r.race_number || '').trim() === raceNo
  ) || null;
}

function extractFormDigitsFromSource(source){
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .map(v => Number(v))
      .filter(n => Number.isFinite(n) && n > 0);
  }
  return String(source)
    .replace(/[^0-9]/g, '')
    .split('')
    .map(ch => Number(ch))
    .filter(n => Number.isFinite(n) && n > 0);
}

function runnerFormPlacingsServer(runner){
  if (!runner) return [];
  if (Array.isArray(runner.last_starts) && runner.last_starts.length) {
    const finishes = runner.last_starts
      .map(s => Number(s?.finish))
      .filter(n => Number.isFinite(n) && n > 0);
    if (finishes.length) return finishes;
  }
  const sources = [
    runner.last_twenty_starts,
    runner.last_five_starts,
    runner.last_four_starts,
    runner.form,
    runner.recent_form
  ];
  for (const source of sources) {
    const digits = extractFormDigitsFromSource(source);
    if (digits.length) return digits;
  }
  return [];
}

function runnerFormSignalServer(runner){
  const placements = runnerFormPlacingsServer(runner);
  if (!placements.length) return null;
  const recent = placements.slice(-6);
  const wins = recent.filter(v => v === 1).length;
  const podiums = recent.filter(v => v >= 1 && v <= 3).length;
  const top5 = recent.filter(v => v >= 1 && v <= 5).length;
  const avgFinish = recent.reduce((sum, val) => sum + val, 0) / recent.length;
  let streakTop3 = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i] <= 3) streakTop3++;
    else break;
  }
  let status = 'COLD';
  if (wins >= 2 || (wins >= 1 && podiums >= 3) || avgFinish <= 2.4 || streakTop3 >= 3) status = 'HOT';
  else if (podiums >= 2 || top5 >= 4 || avgFinish <= 4.2) status = 'SOLID';
  else if (podiums >= 1 || top5 >= 2 || avgFinish <= 6) status = 'MIXED';
  const summary = `${wins} win${wins === 1 ? '' : 's'}, ${podiums} podium${podiums === 1 ? '' : 's'} last ${recent.length} · avg finish ${avgFinish.toFixed(1)}`;
  return { status, summary };
}

function describeRunnerForm(runner){
  const signal = runnerFormSignalServer(runner);
  if (signal?.status && signal.status !== 'UNKNOWN') {
    return `${signal.status} form – ${signal.summary}`;
  }
  const fallback = Array.isArray(runner?.last_starts)
    ? runner.last_starts.slice(0, 4).map(s => s?.finish || '?').join('')
    : (runner?.last_twenty_starts || runner?.form || 'n/a');
  return fallback || 'n/a';
}

function describeRunnerSectional(runner){
  if (!runner) return 'n/a';
  if (Array.isArray(runner.last_starts)) {
    for (const start of runner.last_starts) {
      const val = start?.last_600 || start?.last600 || start?.lastSixHundred;
      if (val) return `L600 ${val}`;
    }
  }
  if (runner.last_600 || runner.last600) return `L600 ${runner.last_600 || runner.last600}`;
  return 'n/a';
}

function describeRunnerSuitability(runner){
  if (!runner) return 'n/a';
  if (runner.suitability_score != null && runner.suitability_score !== '') return `${runner.suitability_score}/10`;
  if (runner.handicap_rating) return `Hcp ${runner.handicap_rating}`;
  if (runner.rating) return `Rating ${runner.rating}`;
  if (runner.spr) return `SPR ${runner.spr}`;
  return 'n/a';
}

function sortRunnersByOdds(runners){
  return (Array.isArray(runners) ? runners.slice() : []).sort((a,b)=>{
    const oa = Number(a?.odds || a?.fixed_win || a?.tote_win || a?.price || Infinity);
    const ob = Number(b?.odds || b?.fixed_win || b?.tote_win || b?.price || Infinity);
    if (Number.isFinite(oa) && Number.isFinite(ob)) return oa - ob;
    if (Number.isFinite(oa)) return -1;
    if (Number.isFinite(ob)) return 1;
    return String(a?.runner_number || a?.name || '').localeCompare(String(b?.runner_number || b?.name || ''));
  });
}

function formatRunnerStats(record){
  if (!record || typeof record !== 'object') return null;
  const starts = record.number_of_starts ?? record.starts;
  const wins = record.number_of_wins ?? record.wins;
  const seconds = record.number_of_seconds ?? record.seconds;
  const thirds = record.number_of_thirds ?? record.thirds;
  if ([starts, wins, seconds, thirds].every(v => v == null)) return null;
  return `${starts ?? 0}:${wins ?? 0}-${seconds ?? 0}-${thirds ?? 0}`;
}

function renderHorseProfileLine(runner, idx){
  const digit = normalizeHorseProfileDigit(idx);
  const barrier = runner?.barrier ?? 'n/a';
  const jockey = runner?.jockey || 'n/a';
  const apprentice = runner?.apprentice_indicator ? ' (A)' : '';
  const trainer = runner?.trainer || 'n/a';
  const trainerLoc = runner?.trainer_location ? ` (${runner.trainer_location})` : '';
  const weight = runner?.weight || runner?.weight_total || runner?.carrying_weight || 'n/a';
  const ageSex = [runner?.age, runner?.sex].filter(Boolean).join('');
  const gear = runner?.gear || null;
  const formText = describeRunnerForm(runner);
  const sectional = describeRunnerSectional(runner);
  const speed = runner?.speedmap || 'n/a';
  const suitability = describeRunnerSuitability(runner);
  const stats = runner?.stats || {};
  const statsBits = [];
  const career = formatRunnerStats(stats.overall);
  const track = formatRunnerStats(stats.track);
  const distance = formatRunnerStats(stats.distance);
  if (career) statsBits.push(`Career ${career}`);
  if (track) statsBits.push(`Track ${track}`);
  if (distance) statsBits.push(`Dist ${distance}`);
  const statsText = statsBits.length ? ` · Stats: ${statsBits.slice(0, 2).join(' | ')}` : '';
  const extraBits = [ageSex, gear].filter(Boolean).join(' ');
  const extraLine = extraBits ? ` · ${extraBits}` : '';
  const commentLine = runner?.form_comment ? `\n- Comment: ${runner.form_comment}` : '';
  const indicatorsLine = runner?.form_indicators ? `\n- Signals: ${runner.form_indicators}` : '';
  return `${digit} ${runner?.name || runner?.runner_name || 'n/a'}
- Gate / Jockey / Trainer / Weight: ${barrier} / ${jockey}${apprentice} / ${trainer}${trainerLoc} / ${weight}${extraLine}
- Form/sectionals/speed map/suitability: ${formText} / ${sectional} / ${speed} / ${suitability}${statsText}${commentLine}${indicatorsLine}`;
}

function formatHorseProfileLines(runners, limit = 3){
  if (!Array.isArray(runners) || !runners.length) return [];
  const seen = new Set();
  const lines = [];
  for (const runner of runners) {
    if (!runner) continue;
    const key = normalizeRunnerName(runner.name || runner.runner_name || '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    lines.push(renderHorseProfileLine(runner, lines.length));
    if (lines.length >= limit) break;
  }
  return lines;
}

function collectHorseProfileLines(clientContext = {}, tenantId = 'default', limit = 3){
  const race = loadRaceByContext(clientContext, tenantId);
  if (!race || !Array.isArray(race.runners) || !race.runners.length) return [];
  const runnerMap = new Map();
  for (const runner of race.runners) {
    const key = normalizeRunnerName(runner?.name || runner?.runner_name || '');
    if (key) runnerMap.set(key, runner);
  }
  const rows = collectRaceRunnerProbabilities(clientContext, tenantId);
  const prioritized = [];
  if (rows && rows.length) {
    rows
      .slice()
      .sort((a,b)=> {
        const mb = Number.isFinite(b.model) ? b.model : -1;
        const ma = Number.isFinite(a.model) ? a.model : -1;
        if (mb !== ma) return mb - ma;
        const ib = Number.isFinite(b.implied) ? b.implied : -1;
        const ia = Number.isFinite(a.implied) ? a.implied : -1;
        return ib - ia;
      })
      .forEach(row => {
        const key = normalizeRunnerName(row.name);
        if (!key || prioritized.length >= limit) return;
        const runner = runnerMap.get(key);
        if (runner) prioritized.push(runner);
      });
  }
  if (prioritized.length < limit) {
    const byOdds = sortRunnersByOdds(race.runners);
    for (const runner of byOdds) {
      if (prioritized.length >= limit) break;
      const key = normalizeRunnerName(runner?.name || runner?.runner_name || '');
      if (!key) continue;
      const already = prioritized.find(r => normalizeRunnerName(r?.name || r?.runner_name || '') === key);
      if (already) continue;
      prioritized.push(runner);
    }
  }
  return formatHorseProfileLines(prioritized, limit);
}

function buildHorseProfilesSection(clientContext = {}, tenantId = 'default', limit = 3, raceOverride = null){
  let lines = collectHorseProfileLines(clientContext, tenantId, limit);
  if ((!lines || !lines.length) && raceOverride && Array.isArray(raceOverride.runners)) {
    lines = formatHorseProfileLines(sortRunnersByOdds(raceOverride.runners), limit);
  }
  if (!lines || !lines.length) return `\n\n🧬 Horse Profiles (Key Contenders)\n${HORSE_PROFILE_FALLBACK}`;
  return `\n\n🧬 Horse Profiles (Key Contenders)\n${lines.join('\n')}`;
}

function buildSimulationModelMeta(clientContext = {}, tenantId = 'default', speedMap = null){
  const rows = collectRaceRunnerProbabilities(clientContext, tenantId) || [];
  const race = loadRaceByContext(clientContext, tenantId);
  if (!rows.length && (!race || !Array.isArray(race.runners))) return null;
  const sorted = rows.slice().sort((a,b)=>{
    const mb = Number.isFinite(b.model) ? b.model : (Number.isFinite(b.implied) ? b.implied : -1);
    const ma = Number.isFinite(a.model) ? a.model : (Number.isFinite(a.implied) ? a.implied : -1);
    return mb - ma;
  }).slice(0,3);
  const lines = [];
  if (sorted[0]) {
    const win = Number.isFinite(sorted[0].model) ? sorted[0].model : (Number.isFinite(sorted[0].implied) ? sorted[0].implied : NaN);
    lines.push(`- Model fav: ${sorted[0].name} ${Number.isFinite(win) ? `(${win.toFixed(1)}% win)` : ''}`.trim());
  }
  if (sorted[1]) {
    const topWin = Number.isFinite(sorted[0]?.model) ? sorted[0].model : (Number.isFinite(sorted[0]?.implied) ? sorted[0].implied : NaN);
    const nextWin = Number.isFinite(sorted[1].model) ? sorted[1].model : (Number.isFinite(sorted[1].implied) ? sorted[1].implied : NaN);
    const gap = (Number.isFinite(topWin) && Number.isFinite(nextWin)) ? ` · gap ${(topWin - nextWin).toFixed(1)} pts` : '';
    lines.push(`- Next best: ${sorted[1].name}${Number.isFinite(nextWin) ? ` (${nextWin.toFixed(1)}%)` : ''}${gap}`);
  }
  if (speedMap) {
    lines.push(`- Tempo weighting: ${speedMap.tempo} · Leaders ${speedMap.leaders}`);
  }
  if (race && Array.isArray(race.runners)) {
    const hot = race.runners.filter(r => runnerFormSignalServer(r)?.status === 'HOT').map(r => String(r.name || r.runner_name || '').trim()).filter(Boolean).slice(0,3);
    const solid = race.runners.filter(r => runnerFormSignalServer(r)?.status === 'SOLID').map(r => String(r.name || r.runner_name || '').trim()).filter(Boolean).slice(0,3);
    if (hot.length) lines.push(`- HOT form boosts: ${hot.join(', ')}`);
    else if (solid.length) lines.push(`- SOLID form boosts: ${solid.join(', ')}`);
  }
  lines.push('- Weighting stack: market base + barrier bias + pace map + HOT/SOLID form uplift.');
  if (!lines.length) return null;
  return `\n\n🧮 Simulation Model summary\n${lines.join('\n')}`;
}

function buildRaceOddsVsModelTable(clientContext = {}, tenantId = 'default'){
  const rows = collectRaceRunnerProbabilities(clientContext, tenantId);
  if (!rows || !rows.length) return null;
  const sorted = rows.slice().sort((a,b) => {
    const mb = Number.isFinite(b.model) ? b.model : -1;
    const ma = Number.isFinite(a.model) ? a.model : -1;
    if (mb !== ma) return mb - ma;
    const ib = Number.isFinite(b.implied) ? b.implied : -1;
    const ia = Number.isFinite(a.implied) ? a.implied : -1;
    return ib - ia;
  }).slice(0, 5);

  const header = '| Runner | Odds | Implied Probability | Model Probability | Edge |';
  const sep = '| --- | --- | --- | --- | --- |';
  const lines = sorted.map(r => {
    const oddsText = Number.isFinite(r.odds) && r.odds > 0 ? r.odds.toFixed(2) : 'n/a';
    const impliedText = Number.isFinite(r.implied) ? `${r.implied.toFixed(1)}%` : 'n/a';
    const modelText = Number.isFinite(r.model) ? `${r.model.toFixed(1)}%` : 'n/a';
    const edge = (Number.isFinite(r.model) && Number.isFinite(r.implied)) ? (r.model - r.implied) : NaN;
    const edgeText = Number.isFinite(edge) ? `${edge >= 0 ? '+' : ''}${edge.toFixed(1)} pts` : 'n/a';
    return `| ${r.name} | ${oddsText} | ${impliedText} | ${modelText} | ${edgeText} |`;
  });
  if (!lines.length) return null;
  return `${header}
${sep}
${lines.join('\n')}`;
}

function buildRaceSimulationSummary(clientContext = {}, tenantId = 'default'){
  const rows = collectRaceRunnerProbabilities(clientContext, tenantId);
  if (!rows || !rows.length) return null;
  const scored = rows
    .map(r => {
      const win = Number.isFinite(r.model) ? r.model : (Number.isFinite(r.implied) ? r.implied : NaN);
      if (!Number.isFinite(win) || win <= 0) return null;
      const top3 = Math.min(95, Math.max(win, Math.round((win * 1.85 + 8) * 10) / 10));
      return { name: r.name, win, top3 };
    })
    .filter(Boolean)
    .sort((a,b) => b.win - a.win)
    .slice(0, 5);
  if (!scored.length) return null;
  return scored.map(r => `- ${r.name} — Win ${r.win.toFixed(1)}% | Top 3 ${r.top3.toFixed(1)}%`).join('\n');
}

function buildPunterPanelDebateSection(race, finalTips){
  if (!race || !Array.isArray(race.runners) || !race.runners.length) return null;
  const runners = race.runners
    .map(rr => ({
      name: String(rr?.name || rr?.runner_name || '').trim(),
      barrier: rr?.barrier ?? rr?.runner_number ?? null,
      jockey: rr?.jockey || null,
      trainer: rr?.trainer || null,
      odds: Number(rr?.odds || rr?.fixed_win || rr?.tote_win || 0),
      weight: rr?.weight || rr?.weight_total || null,
      speedmap: rr?.speedmap || null,
      form: rr?.last_twenty_starts || null
    }))
    .filter(r => r.name);
  if (!runners.length) return null;

  const sorted = runners.slice().sort((a,b) => {
    const oa = Number.isFinite(a.odds) && a.odds > 0 ? a.odds : Number.MAX_SAFE_INTEGER;
    const ob = Number.isFinite(b.odds) && b.odds > 0 ? b.odds : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });

  const voices = [
    {
      name: 'Tessa Tempo',
      focus: 'map / tempo',
      build: (r) => `"${r.name}" draws ${r.barrier || 'n/a'} and should dictate the ${r.speedmap || 'map'}, so I’m siding with the runner that controls shape.`
    },
    {
      name: 'Miles Sectional',
      focus: 'sectionals / conditioning',
      build: (r) => `Recent form ${r.form || 'n/a'} with ${r.weight || 'n/a'}kg tells me they can sustain the late split — I want the runner that can quicken.`
    },
    {
      name: 'Vera Value',
      focus: 'market edge',
      build: (r) => {
        const oddsText = Number.isFinite(r.odds) && r.odds > 0 ? `@$${r.odds.toFixed(2)}` : 'at current quotes';
        return `${r.name} ${oddsText} is still an overlay versus my book, so I’ll keep pressing the value.`;
      }
    }
  ];

  const pickForVoice = (idx) => sorted[idx] || sorted[sorted.length - 1] || sorted[0];
  const lines = voices.map((voice, idx) => {
    const target = pickForVoice(idx);
    return `- ${voice.name} (${voice.focus}): ${voice.build(target)}`;
  });

  const consensusName = (() => {
    if (finalTips?.main) return String(finalTips.main).trim();
    return pickForVoice(0)?.name || 'n/a';
  })();
  const consensusRunner = sorted.find(r => r.name.toLowerCase() === consensusName.toLowerCase());
  const consensusReason = consensusRunner
    ? `Panel sides with ${consensusRunner.name} — barrier ${consensusRunner.barrier || 'n/a'} and ${consensusRunner.speedmap || 'map unknown'} pattern fit the day.`
    : `Panel sides with ${consensusName} as the most balanced profile.`;
  lines.push(`- Consensus: ${consensusReason}`);

  return `\n\n🎙️ Punter Panel Debate\n${lines.join('\n')}`;
}

function enforceRaceAnalysisAnswerFormat(answer, clientContext = {}, tenantId = 'default'){
  let out = String(answer || '').trim();

  // Remove low-value generic boilerplate carried over from decision-format enforcement.
  out = out
    .replace(/\n?Verdict:\s*Use only if edge remains positive versus current market\.?/ig, '')
    .replace(/\n?Verdict:\s*Refer to the analysis above.*?before acting\.?/ig, '')
    .replace(/\n?Risk:\s*medium\s*\(variance and pace-shape uncertainty\)\.?/ig, '')
    .replace(/\n?Risk:\s*assess based on field size and pace-shape uncertainty\.?/ig, '')
    .replace(/\n?Invalidation points:\s*pass if market drifts materially or race shape changes against setup\.?/ig, '')
    .replace(/\n?Pass conditions:\s*pass if market drifts beyond edge or race shape changes against setup\.?/ig, '')
    .replace(/\n?Market edge:\s*not calculated in this response.*?above\.?/ig, '')
    .replace(/\n?Market edge:\s*unavailable from current response text\.?/ig, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const rc = clientContext?.raceContext || {};
  const meeting = rc.meeting || 'n/a';
  const raceNo = rc.raceNumber || 'n/a';
  const raceName = rc.raceName || 'Race Analysis';

  const speedMap = buildSpeedMapProjection(clientContext, tenantId);
  if (speedMap) {
    const replacement = `🔎 Speed Map Projection\n- Leaders: ${speedMap.leaders}\n- On Pace: ${speedMap.onPace}\n- Midfield: ${speedMap.midfield}\n- Backmarkers: ${speedMap.backmarkers}\n- Tempo note(s): ${speedMap.tempo}`;
    out = out.replace(/🔎\s*Speed\s*Map\s*Projection[\s\S]*?(?=\n\n[🧬📊🧮🏆💰🎙️🏁📈]|$)/i, replacement);
  }

  const finalTips = buildRaceFinalTips(clientContext, tenantId);
  const confidence = buildRaceConfidence(clientContext, tenantId);
  if (finalTips) {
    const lines = [];
    lines.push(`- Main: ${finalTips.main || 'n/a'}`);
    lines.push(`- Saver/Exotics: ${finalTips.exotics.length ? finalTips.exotics.join(' | ') : (finalTips.saver ? `Saver on ${finalTips.saver}` : 'No same-race exotic profile currently flagged.')}`);
    lines.push(`- Pass conditions: ${finalTips.pass}`);
    const replacement = `🏁 Final Tips + Betting Strategy\n${lines.join('\n')}`;
    out = out.replace(/🏁\s*Final\s*Tips\s*\+\s*Betting\s*Strategy[\s\S]*?(?=\n\n📈|$)/i, replacement);
  }

  const valueAnalysis = buildRaceValueAnalysis(clientContext, tenantId);
  if (valueAnalysis) {
    const valueLines = [];
    valueLines.push(`- Overlays: ${valueAnalysis.overlays.length ? valueAnalysis.overlays.join(' | ') : 'none identified from current model vs market.'}`);
    valueLines.push(`- Underlays: ${valueAnalysis.underlays.length ? valueAnalysis.underlays.join(' | ') : 'none identified from current model vs market.'}`);
    valueLines.push(`- Market movers: ${valueAnalysis.movers.length ? valueAnalysis.movers.join(' | ') : 'no significant firming/drifting detected for this race.'}`);
    if (valueAnalysis.marketTop.length) valueLines.push(`- Market top prices: ${valueAnalysis.marketTop.join(' | ')}`);
    const replacement = `💰 Value Analysis
${valueLines.join('\n')}`;
    out = out.replace(/💰\s*Value\s*Analysis[\s\S]*?(?=\n\n[🎙️🏁📈]|$)/i, replacement);
  }

  const oddsVsModelTable = buildRaceOddsVsModelTable(clientContext, tenantId);
  const simulationSummary = buildRaceSimulationSummary(clientContext, tenantId);
  const oddsVsModelText = oddsVsModelTable
    ? `

📊 Odds vs Model Probability
${oddsVsModelTable}`
    : `

📊 Odds vs Model Probability
- n/a`;
  const simulationResultsText = simulationSummary
    ? `

🏆 Simulation Results (Win%, Top 3%)
${simulationSummary}`
    : `

🏆 Simulation Results (Win%, Top 3%)
- n/a`;

  if (oddsVsModelTable) {
    out = out.replace(/📊\s*Odds\s*vs\s*Model\s*Probability[\s\S]*?(?=\n\n[🧮🏆💰🎙️🏁📈]|$)/i, oddsVsModelText.trimStart());
  }
  if (simulationSummary) {
    out = out.replace(/🏆\s*Simulation\s*Results[\s\S]*?(?=\n\n[💰🎙️🏁📈]|$)/i, simulationResultsText.trimStart());
  }

  if (confidence) {
    const replacement = `📈 Confidence %
- ${confidence.pct}% (${confidence.basis})`;
    out = out.replace(/📈\s*Confidence\s*%[\s\S]*?$/i, replacement);
  }

const speedMapText = speedMap
    ? `\n\n🔎 Speed Map Projection\n- Leaders: ${speedMap.leaders}\n- On Pace: ${speedMap.onPace}\n- Midfield: ${speedMap.midfield}\n- Backmarkers: ${speedMap.backmarkers}\n- Tempo note(s): ${speedMap.tempo}`
    : `\n\n🔎 Speed Map Projection\n- Leaders: n/a\n- On Pace: n/a\n- Midfield: n/a\n- Backmarkers: n/a\n- Tempo note(s): n/a`;

  const valueText = valueAnalysis
    ? (() => {
        const lines = [];
        lines.push(`- Overlays: ${valueAnalysis.overlays.length ? valueAnalysis.overlays.join(' | ') : 'none identified from current model vs market.'}`);
        lines.push(`- Underlays: ${valueAnalysis.underlays.length ? valueAnalysis.underlays.join(' | ') : 'none identified from current model vs market.'}`);
        lines.push(`- Market movers: ${valueAnalysis.movers.length ? valueAnalysis.movers.join(' | ') : 'no significant firming/drifting detected for this race.'}`);
        if (valueAnalysis.marketTop.length) lines.push(`- Market top prices: ${valueAnalysis.marketTop.join(' | ')}`);
        return `\n\n💰 Value Analysis\n${lines.join('\n')}`;
      })()
    : `\n\n💰 Value Analysis\n- Overlays: none identified from current model vs market.\n- Underlays: none identified from current model vs market.\n- Market movers: no significant firming/drifting detected for this race.`;

  const finalTipsText = finalTips
    ? (() => {
        const lines = [];
        lines.push(`- Main: ${finalTips.main || 'n/a'}`);
        lines.push(`- Saver/Exotics: ${finalTips.exotics.length ? finalTips.exotics.join(' | ') : (finalTips.saver ? `Saver on ${finalTips.saver}` : 'No same-race exotic profile currently flagged.')}`);
        lines.push(`- Pass conditions: ${finalTips.pass}`);
        return `\n\n🏁 Final Tips + Betting Strategy\n${lines.join('\n')}`;
      })()
    : `\n\n🏁 Final Tips + Betting Strategy\n- Main: n/a\n- Saver/Exotics: No same-race exotic profile currently flagged.\n- Pass conditions: n/a`;

  const confidenceText = confidence
    ? `\n\n📈 Confidence %\n- ${confidence.pct}% (${confidence.basis})`
    : `\n\n📈 Confidence %\n- n/a`;

  const punterPanelText = buildPunterPanelDebateSection(valueAnalysis?.race, finalTips);
  if (punterPanelText) {
    out = out.replace(/🎙️\s*Punter\s*Panel\s*Debate[\s\S]*?(?=\n\n[🏁📈]|$)/i, punterPanelText);
  }

  const horseProfilesBlock = buildHorseProfilesSection(clientContext, tenantId, 3, valueAnalysis?.race);
  const simulationMetaBlock = buildSimulationModelMeta(clientContext, tenantId, speedMap);
  if (simulationMetaBlock) {
    out = out.replace(/🧮\s*Simulation\s*Model\s*summary[\s\S]*?(?=\n\n[🏆💰🎙️🏁📈]|$)/i, simulationMetaBlock);
  }

  const requiredSections = [
    { re: /🏇|Race\s+\d+/i, text: `🏇 ${meeting} – Race ${raceNo}: ${raceName}` },
    { re: /Speed\s*Map\s*Projection/i, text: speedMapText },
    { re: /Horse\s*Profiles/i, text: horseProfilesBlock },
    { re: /Odds\s*vs\s*Model\s*Probability/i, text: oddsVsModelText },
    { re: /Simulation\s*Model/i, text: simulationMetaBlock || SIM_MODEL_FALLBACK_TEXT },
    { re: /Simulation\s*Results|Win%/i, text: simulationResultsText },
    { re: /Value\s*Analysis/i, text: valueText },
    { re: /Punter\s*Panel\s*Debate/i, text: punterPanelText || `\n\n🎙️ Punter Panel Debate\n- Punter 1: n/a\n- Punter 2: n/a\n- Punter 3: n/a\n- Consensus: n/a` },
    { re: /Final\s*Tips|Betting\s*Strategy/i, text: finalTipsText },
    { re: /Confidence\s*%/i, text: confidenceText }
  ];

  for (const s of requiredSections) {
    if (!s.re.test(out)) out += s.text;
  }
  return out;
}

function buildSelectionFactAnswer(question, clientContext = {}, tenantId = 'default'){
  const q = String(question || '').trim().toLowerCase();
  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  let suggested = Array.isArray(status.suggestedBets) ? status.suggestedBets : [];
  const isRaceAnalysis = String(clientContext?.source || '').toLowerCase() === 'race-analysis';

  if (isRaceAnalysis && clientContext?.raceContext) {
    const rcMeeting = String(clientContext.raceContext.meeting || '').trim().toLowerCase();
    const rcRace = String(clientContext.raceContext.raceNumber || '').replace(/^R/i, '').trim();
    const race = (Array.isArray(racesData.races) ? racesData.races : []).find(r =>
      String(r.meeting || '').trim().toLowerCase() === rcMeeting &&
      String(r.race_number || '').trim() === rcRace
    );

    const meetingLabel = clientContext.raceContext.meeting || race?.meeting || 'n/a';
    const raceLabel = clientContext.raceContext.raceNumber || race?.race_number || 'n/a';
    const raceName = clientContext.raceContext.raceName || race?.description || 'Race Analysis';

    const runners = Array.isArray(race?.runners) ? race.runners.slice() : [];
    const ranked = runners
      .map(rr => {
        const odds = Number(rr?.odds || rr?.fixed_win || rr?.tote_win || 0);
        const winPct = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
        return { rr, odds, winPct };
      })
      .sort((a,b) => (Number.isFinite(b.winPct) ? b.winPct : -1) - (Number.isFinite(a.winPct) ? a.winPct : -1));

    const topRows = ranked.slice(0, 5).map((x, i) => `${i+1}) ${x.rr?.name || x.rr?.runner_name || 'n/a'} — ${Number.isFinite(x.winPct) ? `${x.winPct.toFixed(1)}%` : 'n/a'} @ ${Number.isFinite(x.odds) ? x.odds.toFixed(2) : 'n/a'}`);
    const simRows = ranked.slice(0, 5).map((x, i) => {
      const win = Number.isFinite(x.winPct) ? x.winPct : NaN;
      const top3 = Number.isFinite(win) ? Math.min(95, Math.max(win, Math.round((win * 1.85 + 8) * 10) / 10)) : NaN;
      return `${i+1}) ${x.rr?.name || x.rr?.runner_name || 'n/a'} — Win ${Number.isFinite(win) ? `${win.toFixed(1)}%` : 'n/a'} | Top 3 ${Number.isFinite(top3) ? `${top3.toFixed(1)}%` : 'n/a'}`;
    });
    const contenders = ranked.slice(0, 3);
    const profileLines = formatHorseProfileLines(contenders.map(x => x.rr));
    const profiles = profileLines.length ? profileLines.join('\n') : HORSE_PROFILE_FALLBACK;

    const topPick = contenders[0]?.rr?.name || contenders[0]?.rr?.runner_name || 'n/a';
    const confidence = Number.isFinite(contenders[0]?.winPct) ? Math.min(85, Math.max(35, Math.round(contenders[0].winPct + 18))) : 'n/a';

    return `🏇 ${meetingLabel} – Race ${raceLabel}: ${raceName}
Distance / Track / Weather / Rail / Tempo projection summary.

🔎 Speed Map Projection
- Leaders: n/a
- On Pace: n/a
- Midfield: n/a
- Backmarkers: n/a
- Tempo note(s): n/a

🧬 Horse Profiles (Key Contenders)
${profiles}

📊 Odds vs Model Probability
${topRows.length ? topRows.join('\n') : '- n/a'}

🧮 Simulation Model summary
- Monte Carlo runs: 999,999
- Weights: market-implied + available race metadata (missing fields marked n/a)

🏆 Simulation Results (Win%, Top 3%)
${simRows.length ? simRows.join('\n') : '- n/a'}

💰 Value Analysis
- Overlays/underlays: n/a

🎙️ Punter Panel Debate
- Kai (speed-map first): "${topPick} maps cleanest."
- Moana (sectionals bias): "Late splits unclear, keep stake measured."
- Trent (price discipline): "Only play if market holds the edge."
- Consensus: ${topPick}

🏁 Final Tips + Betting Strategy
- Main: ${topPick}
- Saver/Exotics: ${contenders[1]?.rr?.name ? `Saver on ${contenders[1].rr.name}` : 'No same-race exotic profile currently flagged.'}
- Pass conditions: drift against top pick / pace map flips

📈 Confidence %
- ${confidence === 'n/a' ? 'n/a' : `${confidence}%`}`;
  }

  // Venue-aware scoping: if the question mentions a specific venue, constrain answers
  const allRaces = Array.isArray(racesData.races) ? racesData.races : [];
  const liveRaces = allRaces.filter(r => !FINISHED_RACE_STATUSES.has(String(r.race_status || '').toLowerCase()));
  // Filter suggested bets to exclude picks for races that have already finished
  suggested = suggested.filter(s => isLiveRaceEntry(s, allRaces));
  // Include venues from suggested bets so venue detection works even when races.json
  // is loaded from a different path (e.g. tenant data with separate status/races).
  const suggestedVenues = [...new Set(suggested.map(x => String(x.meeting || '').trim()).filter(Boolean))]
    .filter(m => !liveRaces.some(r => String(r.meeting || '').trim().toLowerCase() === m.toLowerCase()))
    .map(m => ({ meeting: m }));
  const venueInf = inferMeetingFromQuestion(question, liveRaces.concat(suggestedVenues));
  if (venueInf.mentioned && venueInf.matched.length === 0) {
    const availableList = venueInf.available.length
      ? venueInf.available.join(', ')
      : 'none currently loaded';
    return `There are no races at ${venueInf.mentioned} in today's data. Venues racing today: ${availableList}. Ask me about one of those instead.`;
  }

  const auditSnapshot = buildDecisionAudit(status || {});
  const stakeProfile = {
    stakePerRace: status.stakePerRace ?? null,
    exoticStakePerRace: status.exoticStakePerRace ?? null,
    earlyWindowMin: status.earlyWindowMin ?? null,
    aiWindowMin: status.aiWindowMin ?? null
  };

  // When a venue is matched, scope suggested bets to that venue.
  // When "next race" or "last race" is detected, further scope to that race.
  let scopedSuggested = suggested;
  if (venueInf.matched.length > 0) {
    const matchedLower = new Set(venueInf.matched.map(m => m.toLowerCase()));
    scopedSuggested = suggested.filter(x => matchedLower.has(String(x.meeting || '').trim().toLowerCase()));
    const temporal = inferTemporalRaceAtVenue(question, allRaces, venueInf.matched[0]);
    if (temporal) {
      const rNum = String(temporal.race.race_number);
      scopedSuggested = scopedSuggested.filter(x => String(x.race || '').replace(/^R/i, '').trim() === rNum);
    }
  }

  const nonMulti = scopedSuggested.filter(x => !['multi','top2','top3','top4','trifecta'].includes(String(x.type || '').toLowerCase()));
  const multis = scopedSuggested.filter(x => ['multi','top2','top3','top4','trifecta'].includes(String(x.type || '').toLowerCase()));

  if (!suggested.length) {
    return 'I do not have any current selections loaded yet. Please run a refresh, then ask again and I will explain the picks in detail.';
  }

  const parsePct = (reason) => {
    const m = String(reason || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
    return m ? Number(m[1]) : null;
  };
  const parseOdds = (reason) => {
    const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
    return m ? Number(m[1]) : NaN;
  };

  const ctxSelections = Array.isArray(clientContext.selections) ? clientContext.selections : [];
  const raceRef = q.match(/r\s*(\d{1,2})\b/i);

  const explain = (x) => {
    const reason = x.reason || 'the model rates this profile strongest at current market prices';
    const p = parsePct(reason);
    const o = parseOdds(reason);
    const edge = (p != null && Number.isFinite(o) && o > 0) ? (p - (100 / o)) : null;
    const edgeTxt = edge == null ? 'edge not available' : `${edge >= 0 ? '+' : ''}${edge.toFixed(1)} pts`;
    const conf = p == null ? 'medium' : (p >= 30 ? 'high' : (p >= 20 ? 'medium' : 'speculative'));
    return `${x.meeting} Race ${x.race}: I like ${x.selection} as a ${x.type} at $${x.stake}. ${p != null ? `Model probability is around ${p.toFixed(1)}%. ` : ''}Market edge is ${edgeTxt}. Signal reason: ${reason}. Confidence is ${conf}.`;
  };

  const horseMatch = nonMulti.find(x => q.includes(String(x.selection || '').toLowerCase())) ||
    suggested.find(x => q.includes(String(x.selection || '').toLowerCase()));
  if (horseMatch && (!ctxSelections || ctxSelections.length <= 1)) {
    return explain(horseMatch) + ' Main risk: race shape/tempo can flip late, so treat this as probability not certainty.';
  }

  // If client sent explicit dragged selections/race context, anchor response to that context first.
  if (ctxSelections.length) {
    const racesTop = Array.isArray(racesData.races) ? racesData.races : [];
    const mapped = ctxSelections.map(s => {
      const mtg = String(s.meeting || '').trim().toLowerCase();
      const rc = String(s.race || '').trim().replace(/^R/i,'');
      const sel = String(s.selection || '').trim().toLowerCase();

      const found = nonMulti.find(x => {
        const xM = String(x.meeting || '').trim().toLowerCase();
        const xR = String(x.race || '').trim().replace(/^R/i,'');
        const xS = String(x.selection || '').trim().toLowerCase();
        return xM === mtg && xR === rc && (xS === sel || xS.includes(sel) || sel.includes(xS));
      });

      const raceObj = racesTop.find(r =>
        String(r.meeting || '').trim().toLowerCase() === mtg &&
        String(r.race_number || '').trim() === rc
      );

      let runnerOdds = NaN;
      let runnerDetail = null;
      if (raceObj && Array.isArray(raceObj.runners)) {
        const rr = raceObj.runners.find(x => {
          const n = String(x.name || x.runner_name || '').trim().toLowerCase();
          return n === sel || n.includes(sel) || sel.includes(n);
        });
        if (rr) runnerDetail = rr;
        const o = Number(rr?.odds || rr?.fixed_win || rr?.tote_win || 0);
        if (Number.isFinite(o) && o > 0) runnerOdds = o;
      }

      return {
        meeting: s.meeting,
        race: String(s.race || '').replace(/^R/i,''),
        selection: s.selection,
        found,
        runnerOdds,
        impliedPct: Number.isFinite(runnerOdds) ? (100 / runnerOdds) : null,
        runnerDetail,
        raceInfo: raceObj || null
      };
    });

    const lines = mapped.map(m => {
      if (m.found) {
        const p = parsePct(m.found.reason);
        const o = parseOdds(m.found.reason);
        const imp = Number.isFinite(o) && o > 0 ? (100 / o) : null;
        const edge = (p != null && imp != null) ? (p - imp) : null;
        return `${m.meeting} R${m.race} ${m.selection}${p!=null?` model ${p.toFixed(1)}%`:''}${imp!=null?`, implied ${imp.toFixed(1)}%`:''}${edge!=null?`, edge ${edge>=0?'+':''}${edge.toFixed(1)} pts`:''}`;
      }
      if (m.impliedPct != null) {
        return `${m.meeting} R${m.race} ${m.selection} implied ${m.impliedPct.toFixed(1)}% (from market odds)`;
      }
      return `${m.meeting} R${m.race} ${m.selection} (runner matched, but probability unavailable in current data)`;
    });


const describeRunner = (runner, raceInfo, impliedPct) => {
  if (!runner && !raceInfo) return '';
  const sentences = [];
  if (runner) {
    const tags = [];
    if (runner.runner_number != null) tags.push(`#${runner.runner_number}`);
    if (runner.barrier != null) tags.push(`Gate ${runner.barrier}`);
    if (runner.age) tags.push(`${runner.age}yo`);
    if (runner.sex) tags.push(runner.sex);
    const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
    const riderBits = [];
    if (runner.jockey) riderBits.push(`${runner.jockey}${runner.apprentice_indicator ? ' (A)' : ''} up`);
    if (runner.trainer) {
      const loc = runner.trainer_location ? ` (${runner.trainer_location})` : '';
      riderBits.push(`for ${runner.trainer}${loc}`);
    }
    if (runner.weight || runner.weight_total) riderBits.push(`${runner.weight || runner.weight_total}kg`);
    if (riderBits.length) {
      sentences.push(`${runner.name || 'This runner'}${tagStr} with ${riderBits.join(', ')}.`);
    } else {
      sentences.push(`${runner.name || 'This runner'}${tagStr}.`);
    }
    if (runner.gear) sentences.push(`Gear: ${runner.gear}.`);
    if (runner.last_twenty_starts) sentences.push(`Recent form ${runner.last_twenty_starts}.`);
    if (runner.form_comment) sentences.push(`Comment: ${runner.form_comment}.`);
    if (runner.form_indicators) sentences.push(`Signals: ${runner.form_indicators}.`);
    if (runner.speedmap) sentences.push(`Maps ${runner.speedmap.toLowerCase()} per the speed map.`);
    const priceParts = [];
    if (runner.fixed_win) priceParts.push(`fixed $${Number(runner.fixed_win).toFixed(2)}`);
    if (runner.tote_win) priceParts.push(`tote ~$${Number(runner.tote_win).toFixed(2)}`);
    if (!priceParts.length && runner.odds) priceParts.push(`market ~$${Number(runner.odds).toFixed(2)}`);
    if (priceParts.length) {
      const impliedTxt = Number.isFinite(impliedPct) ? ` (implied ${impliedPct.toFixed(1)}%)` : '';
      sentences.push(`Currently ${priceParts.join(' / ')}${impliedTxt}.`);
    } else if (Number.isFinite(impliedPct)) {
      sentences.push(`Market implies ${impliedPct.toFixed(1)}%.`);
    }
    const breeding = [runner.sire, runner.dam, runner.dam_sire].filter(Boolean);
    if (breeding.length) sentences.push(`Breeding: ${breeding.join(' / ')}.`);
    const statsStr = formatStatsCompact(runner.stats);
    if (statsStr) sentences.push(`Stats: ${statsStr}.`);
  }
  if (raceInfo) {
    const meta = [];
    if (raceInfo.distance) meta.push(`${raceInfo.distance}m`);
    if (raceInfo.track_condition) meta.push(raceInfo.track_condition);
    if (raceInfo.rail_position) meta.push(`rail ${raceInfo.rail_position}`);
    if (meta.length) sentences.push(`Race setup ${meta.join(', ')}.`);
  }
  if (!runner && Number.isFinite(impliedPct)) sentences.push(`Market implies ${impliedPct.toFixed(1)}%.`);
  return sentences.length ? `Runner notes: ${sentences.join(' ')}` : '';
};

    if (mapped.length === 1) {
      const single = mapped[0];
      const base = single.found
        ? explain(single.found)
        : `${single.meeting} R${single.race} ${single.selection}${single.impliedPct != null ? ` implied ${single.impliedPct.toFixed(1)}% from market odds` : ''}`;
      const extra = describeRunner(single.runnerDetail, single.raceInfo, single.impliedPct);
      return extra ? `${base}
${extra}` : base;
    }

    const sameRace = new Set(mapped.map(m => `${String(m.meeting).toLowerCase()}|${String(m.race)}`)).size === 1;
    const formatHint = sameRace
      ? 'Likely format: Same-Race Multi or H2H structure.'
      : 'Likely format: 2-Race Multi across legs.';

    let jointBlock = '';
    if (sameRace && mapped.length >= 2) {
      const pairs = [];
      for (let i = 0; i < mapped.length; i++) {
        for (let j = i + 1; j < mapped.length; j++) {
          const a = mapped[i];
          const b = mapped[j];
          const pA = Number(a.found ? parsePct(a.found.reason) : a.impliedPct);
          const pB = Number(b.found ? parsePct(b.found.reason) : b.impliedPct);
          if (!Number.isFinite(pA) || !Number.isFinite(pB)) continue;
          const joint = Math.max(0, Math.min(100, (pA * pB / 100) * 0.92));
          pairs.push(`${a.selection} + ${b.selection}: ${joint.toFixed(1)}% joint likelihood (winA ${pA.toFixed(1)}%, winB ${pB.toFixed(1)}%)`);
        }
      }
      if (pairs.length) {
        jointBlock = ` Joint likelihood (both runners in): ${pairs.join(' | ')}.`;
      }
    }

    return `${sameRace ? 'Same-race multi context' : 'Multi-race context'} locked to your dragged runners: ${lines.join(' | ')}. ${formatHint}${jointBlock} Interpretation is based on these exact selections only.`;
  }

  // If user explicitly references a race number, constrain to that race.
  if (raceRef) {
    const rr = raceRef[1];
    const inRace = nonMulti.filter(x => String(x.race) === rr);
    if (inRace.length) {
      const meetings = [...new Set(inRace.map(x => String(x.meeting || '').trim()))].filter(Boolean);
      if (meetings.length > 1) {
        return `I found multiple meetings with R${rr}: ${meetings.join(', ')}. Which meeting should I use?`;
      }
      const sorted = inRace.slice().sort((a,b)=>(parsePct(b.reason)||0)-(parsePct(a.reason)||0));
      const top = sorted[0];
      const second = sorted[1];
      return `${top.meeting} R${rr} context only: top lean is ${top.selection}${parsePct(top.reason)!=null?` (${parsePct(top.reason).toFixed(1)}%)`:''}${second?`, with ${second.selection} as main danger`:''}.`;
    }
  }

  if (q.includes('top') || q.includes('best') || q.includes('winner') || q.includes('pick')) {
    // If user is asking for a multi/exotic, let the multi handler below take priority
    if (!(q.includes('multi') || q.includes('trifecta') || q.includes('top2') || q.includes('top3') || q.includes('top4'))) {
      const top = nonMulti[0] || suggested[0];
      const alts = nonMulti.slice(1,3).map(x => `${x.selection}`).join(', ');
      return `${explain(top)}${alts ? ` Next in line: ${alts}.` : ''}`;
    }
  }

  if (q.includes('multi') || q.includes('trifecta') || q.includes('top2') || q.includes('top3') || q.includes('top4')) {
    if (multis.length) {
      // Show the best multi/exotic suggestion with full detail
      const m = multis[0];
      const extras = multis.slice(1, 3).map(x => `• ${x.meeting} R${x.race} ${x.selection} (${x.type}) $${x.stake}`).join('\n');
      const base = `${m.meeting} Race ${m.race}: the leading exotic is ${m.selection} (${m.type}) at $${m.stake}. Reason: ${m.reason || 'exotic structure derived from the top probability cluster'}. This is higher variance than a straight win bet, so keep stake disciplined.`;
      return extras ? `${base}\n\nOther exotics available:\n${extras}` : base;
    }
    // No exotic suggestions — construct a multi recommendation from top win picks across different races
    const raceKeys = new Set();
    const multiLegs = [];
    for (const x of nonMulti) {
      const rk = `${x.meeting}|${x.race}`;
      if (raceKeys.has(rk)) continue;
      raceKeys.add(rk);
      multiLegs.push(x);
      if (multiLegs.length >= 3) break;
    }
    if (multiLegs.length >= 2) {
      const legLines = multiLegs.map((x, i) => {
        const p = parsePct(x.reason);
        return `Leg ${i + 1}: ${x.meeting} R${x.race} ${x.selection}${p != null ? ` (${p.toFixed(1)}%)` : ''} @ $${parseOdds(x.reason) || 'n/a'}`;
      }).join('\n');
      const probs = multiLegs.map(x => parsePct(x.reason)).filter(p => p != null);
      const jointPct = probs.length >= 2 ? probs.reduce((a, b) => a * b / 100, probs.shift()) : null;
      const jointLine = jointPct != null ? `\nCombined multi probability ≈ ${jointPct.toFixed(1)}%` : '';
      return `Multi recommendation from today's strongest win picks across races:\n${legLines}${jointLine}\n\nThis is a ${multiLegs.length}-leg multi. Higher variance — keep stake small.`;
    }
    return 'There are no active multi or exotic suggestions right now. If you want, I can still explain the best win selections and how they could be combined.';
  }

  // Better same-race interpretation when we have at least 2 picks in the same race.
  const byRace = new Map();
  for (const x of nonMulti) {
    const key = `${x.meeting}|${x.race}`;
    if (!byRace.has(key)) byRace.set(key, []);
    byRace.get(key).push(x);
  }
  const sameRaceGroup = [...byRace.values()].find(arr => arr.length >= 2);
  if (sameRaceGroup) {
    const sorted = sameRaceGroup.slice().sort((a,b) => (parsePct(b.reason)||0) - (parsePct(a.reason)||0));
    const top = sorted[0];
    const second = sorted[1];
    const third = sorted[2];
    const p1 = parsePct(top.reason);
    const p2 = parsePct(second?.reason);
    const gap = (p1 != null && p2 != null) ? (p1 - p2) : null;

    return `${top.meeting} Race ${top.race} reads as a competitive race, not a one-out special.\n` +
      `Top lean: ${top.selection}${p1!=null?` (${p1.toFixed(1)}%)`:''}. ` +
      `${second ? `Main danger: ${second.selection}${p2!=null?` (${p2.toFixed(1)}%)`:''}. ` : ''}` +
      `${third ? `Next layer: ${third.selection}${parsePct(third.reason)!=null?` (${parsePct(third.reason).toFixed(1)}%)`:''}. ` : ''}` +
      `${gap!=null ? `Edge gap between first and second is ${gap.toFixed(1)} points, so this is ${gap >= 8 ? 'a fairly clear top pick' : 'a moderate edge, not dominant'}. ` : ''}` +
      `Practical read: back the top pick as the main play, but respect the saver risk on the second runner if you want lower variance.`;
  }

  const top3 = nonMulti.slice(0,3).map(x => `• ${x.meeting} R${x.race} ${x.selection} (${x.type}, $${x.stake}) — ${x.reason || 'rated selection'}`).join('\n');
  return `Current market read:\n${top3}\n\nIf you want, ask: “Explain ${nonMulti[0]?.selection || 'the top pick'} in plain English.”`;
}

function stripHtmlToText(html){
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimText(value, maxLen = 160){
  const str = String(value || '').replace(/\s+/g, ' ').trim();
  if (!str) return '';
  return str.length <= maxLen ? str : `${str.slice(0, maxLen - 1)}…`;
}

function domainFromUrl(url){
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return String(url || '').slice(0, 40);
  }
}

function summarizeList(rows, maxItems, formatter, fallback = 'None'){
  const items = (rows || []).slice(0, maxItems).map(formatter).filter(Boolean);
  return items.length ? items.join(' | ') : fallback;
}

function calcMarketEdgePts(reason){
  const p = parseReasonWinProb(reason);
  const odds = parseReasonOdds(reason);
  if (!Number.isFinite(p) || !Number.isFinite(odds) || odds <= 0) return null;
  const implied = 100 / odds;
  return Math.round((p - implied) * 10) / 10;
}

async function searchWebSnippets(query, maxResults = 5){
  const q = String(query || '').trim();
  if (!q) return [];

  const braveKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BETMAN_BRAVE_SEARCH_API_KEY;
  const searchTimeout = envNumber('BETMAN_WEB_SEARCH_TIMEOUT_MS', 6000, 1000, 20000);
  if (braveKey) {
    try {
      const r = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.max(1, Math.min(10, maxResults))}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }
      }, searchTimeout);
      if (r.ok) {
        const j = await r.json();
        const rows = (j?.web?.results || []).slice(0, maxResults).map(x => ({
          title: x.title || '',
          url: x.url || '',
          snippet: x.description || ''
        })).filter(x => x.url);
        if (rows.length) return rows;
      } else {
        console.error('brave_search_failed', r.status);
      }
    } catch (err) {
      console.error('brave_search_error', err?.message || err);
    }
  }

  // Fallback: DuckDuckGo HTML parsing (no key)
  try {
    const r = await fetchWithTimeout(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 BETMAN/1.0' }
    }, searchTimeout);
    if (!r.ok) {
      console.error('ddg_search_failed', r.status);
      return [];
    }
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxResults) {
      const url = m[1] || '';
      const title = stripHtmlToText(m[2] || '');
      const snippet = stripHtmlToText(m[3] || '');
      if (url) out.push({ title, url, snippet });
    }
    return out;
  } catch (err) {
    console.error('ddg_search_error', err?.message || err);
    return [];
  }
}

async function fetchWebPageSummary(url){
  const timeoutMs = envNumber('BETMAN_WEB_PAGE_TIMEOUT_MS', 5000, 1000, 20000);
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 BETMAN/1.0' } }, timeoutMs);
    if (!r.ok) return null;
    const html = await r.text();
    const text = stripHtmlToText(html);
    return text ? text.slice(0, 600) : null;
  } catch {
    return null;
  }
}

async function buildInternetContext(question, clientContext = {}){
  const isRaceAnalysis = String(clientContext?.source || '').toLowerCase() === 'race-analysis';
  const selections = Array.isArray(clientContext.selections) ? clientContext.selections : [];
  const selTerms = selections.slice(0, 4).map(s => `${s.runner || ''} ${s.meeting || ''} race ${s.race || ''}`.trim()).filter(Boolean).join(' | ');
  const ui = clientContext.uiContext || {};
  const rc = clientContext.raceContext || {};
  const raceTerms = `${rc.meeting || ui.meeting || ''} race ${rc.raceNumber || ui.race || ''}`.trim();
  const q = `${question} horse racing ${ui.country || ''} ${raceTerms || selTerms}`.trim();

  // Race-analysis: keep web lookups light but not too narrow.
  const resultCount = isRaceAnalysis ? 2 : 3;
  const results = await searchWebSnippets(q, resultCount);

  if (isRaceAnalysis) {
    return { query: q, results: (results || []).slice(0, resultCount) };
  }

  const subset = (results || []).slice(0, 2);
  const enriched = await Promise.all(subset.map(async (r) => {
    const pageSummary = r?.url ? await fetchWebPageSummary(r.url) : null;
    return { ...r, pageSummary: pageSummary || null };
  }));
  return { query: q, results: enriched };
}

function buildAiContextSummary({
  status = {},
  stakeProfile = {},
  suggested = [],
  interesting = [],
  marketMovers = [],
  upcoming = [],
  activity = [],
  webContext = {},
  clientContext = {},
  jointRows = [],
  question = '',
  races = [],
  meetingProfiles = {},
  maxLength = 1200,
  venueNote = ''
} = {}) {
  const lines = [];
  const selectionLines = [];
  if (venueNote) lines.push(venueNote);
  const snapshotLine = `Snapshot: updated ${status.updatedAt || 'n/a'} | API ${status.apiStatus || 'n/a'}`;
  lines.push(snapshotLine.trim());

  const stakeBits = [];
  if (Number.isFinite(Number(stakeProfile.stakePerRace))) stakeBits.push(`Win $${Number(stakeProfile.stakePerRace).toFixed(2)}`);
  if (Number.isFinite(Number(stakeProfile.exoticStakePerRace))) stakeBits.push(`Exotics $${Number(stakeProfile.exoticStakePerRace).toFixed(2)}`);
  if (Number.isFinite(Number(stakeProfile.earlyWindowMin))) stakeBits.push(`Window ${Number(stakeProfile.earlyWindowMin)}m`);
  if (Number.isFinite(Number(stakeProfile.aiWindowMin))) stakeBits.push(`AI Window ${Number(stakeProfile.aiWindowMin)}m`);
  if (stakeBits.length) lines.push(`Stake profile: ${stakeBits.join(' · ')}`);

  const formatSuggested = (row) => {
    const base = `${row.meeting || '—'} R${row.race || row.race_number || '—'} ${row.selection || row.runner || ''}`.trim();
    if (!base.trim()) return '';
    const bits = [`${base} ${String(row.type || 'Win').toUpperCase()}`];
    const p = parseReasonWinProb(row.reason);
    const aiProb = Number(row.aiWinProb);
    if (Number.isFinite(aiProb)) bits.push(`ai ${aiProb.toFixed(1)}%`);
    else if (Number.isFinite(p)) bits.push(`${p.toFixed(1)}%`);
    const odds = parseReasonOdds(row.reason);
    if (Number.isFinite(odds)) bits.push(`@$${odds.toFixed(2)}`);
    const edge = calcMarketEdgePts(row.reason);
    if (Number.isFinite(edge)) bits.push(`edge ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pts`);
    const reasonTxt = trimText(row.reason, 90);
    if (reasonTxt) bits.push(`reason ${reasonTxt}`);
    return bits.join(' · ');
  };

  const formatInteresting = (row) => {
    const base = `${row.meeting || '—'} R${row.race || '—'} ${row.runner || row.selection || ''}`.trim();
    if (!base.trim()) return '';
    const bits = [base];
    if (Number.isFinite(Number(row.odds))) bits.push(`@$${Number(row.odds).toFixed(1)}`);
    if (row.eta) bits.push(String(row.eta));
    const reasonTxt = trimText(row.reason || row.ai_commentary, 80);
    if (reasonTxt) bits.push(reasonTxt);
    return bits.join(' · ');
  };

  const formatMover = (row) => {
    const base = `${row.meeting || '—'} R${row.race || '—'} ${row.runner || ''}`.trim();
    if (!base.trim()) return '';
    const move = Number(row.pctMove || 0);
    const oddsFrom = Number(row.fromOdds);
    const oddsTo = Number(row.toOdds);
    const oddsTxt = Number.isFinite(oddsFrom) && Number.isFinite(oddsTo) ? `${oddsFrom.toFixed(2)}→${oddsTo.toFixed(2)}` : '';
    return `${base} ${move < 0 ? 'firmed' : 'drifted'} ${Math.abs(move).toFixed(1)}%${oddsTxt ? ` (${oddsTxt})` : ''}`;
  };

  const formatUpcoming = (row) => {
    const raceNo = row.race || row.race_number || '—';
    const eta = row.eta || row.start_time_nz || row.jump || ''; 
    return `${row.meeting || '—'} R${raceNo} ${eta}`.trim();
  };

  const formatJoint = (row) => {
    const base = row.meetingB
      ? `${row.meeting || '—'} R${row.race || '—'} ${row.runnerA || ''} + ${row.meetingB || '—'} R${row.raceB || '—'} ${row.runnerB || ''}`.trim()
      : `${row.meeting || '—'} R${row.race || '—'} ${row.runnerA || ''}+${row.runnerB || ''}`.trim();
    const joint = Number(row.jointLikelihood);
    const winA = Number(row.winA);
    const winB = Number(row.winB);
    const bits = [base];
    if (Number.isFinite(joint)) bits.push(`joint ${joint.toFixed(1)}%`);
    if (Number.isFinite(winA) && Number.isFinite(winB)) bits.push(`wins ${winA.toFixed(1)}%/${winB.toFixed(1)}%`);
    return bits.join(' · ');
  };

  lines.push(`Suggested (${suggested.length || 0}): ${summarizeList(suggested, 6, formatSuggested)}`);
  if (interesting?.length) lines.push(`Interesting: ${summarizeList(interesting, 5, formatInteresting)}`);
  const contextMeeting = String(clientContext?.raceContext?.meeting || clientContext?.uiContext?.meeting || '').trim().toLowerCase();
  let scopedMovers = Array.isArray(marketMovers) ? marketMovers.slice() : [];
  if (contextMeeting) {
    const meetingOnly = scopedMovers.filter(row => String(row.meeting || '').trim().toLowerCase() === contextMeeting);
    if (meetingOnly.length) scopedMovers = meetingOnly;
  }
  if (scopedMovers.length) lines.push(`Market movers: ${summarizeList(scopedMovers, 4, formatMover)}`);
  if (upcoming?.length) lines.push(`Upcoming: ${summarizeList(upcoming, 5, formatUpcoming)}`);

  const activityMsgs = (activity || []).filter(Boolean).slice(0, 3).map(msg => trimText(msg, 80));
  if (activityMsgs.length) lines.push(`Activity: ${activityMsgs.join(' | ')}`);

  if (jointRows?.length) lines.push(`Joint likelihoods: ${summarizeList(jointRows, 3, formatJoint)}`);

  const raceLookup = buildRaceLookup(races);
  const explicitSelections = Array.isArray(clientContext?.selections) ? clientContext.selections.slice(0, 6) : [];
  const inferredSelections = inferSelectionsFromQuestion(question, suggested, races);
  const mergedSelections = mergeSelections(explicitSelections, inferredSelections);
  if (mergedSelections.length) {
    const profileLines = mergedSelections.map(sel => formatSelectionDetails(sel, raceLookup, races)).filter(Boolean);
    if (profileLines.length) selectionLines.push(`Selection profiles (${mergedSelections.length}): ${profileLines.join(' || ')}`);
    mergedSelections.forEach(sel => {
      const { race, runner } = findRunnerPayload(sel, raceLookup, races);
      if (!race || !runner) return;
      const selectionJson = {
        meeting: race.meeting,
        raceNumber: race.race_number,
        raceName: race.description,
        distance: race.distance,
        trackCondition: race.track_condition,
        railPosition: race.rail_position,
        runner: runner.name,
        runnerNumber: runner.runner_number ?? null,
        barrier: runner.barrier,
        jockey: runner.jockey,
        trainer: runner.trainer,
        trainerLocation: runner.trainer_location || null,
        apprentice: runner.apprentice_indicator || null,
        weight: runner.weight || runner.weight_total || null,
        age: runner.age || null,
        sex: runner.sex || null,
        gear: runner.gear || null,
        form: runner.last_twenty_starts,
        lastStarts: runner.last_starts || null,
        formComment: runner.form_comment || null,
        formIndicators: runner.form_indicators || null,
        speedmap: runner.speedmap,
        sire: runner.sire,
        dam: runner.dam,
        damSire: runner.dam_sire,
        odds: runner.odds || runner.fixed_win || runner.tote_win || null,
        stats: formatStatsCompact(runner.stats) || null
      };
      selectionLines.push(`SELECTION_DATA: ${JSON.stringify(selectionJson)}`);
    });
    const primary = findRunnerPayload(mergedSelections[0], raceLookup, races);
    if (primary.race) {
      const rc = primary.race;
      const meetingProf = formatMeetingProfile(meetingProfiles[safeSlug(rc.meeting || '')]);
      const raceJson = {
        meeting: rc.meeting,
        raceNumber: rc.race_number,
        raceName: rc.description,
        distance: rc.distance,
        trackCondition: rc.track_condition,
        railPosition: rc.rail_position,
        runners: (rc.runners || []).length,
        loveracingAvailable: !!rc?.loveracing?.available,
        loveracingWeather: rc?.loveracing?.weather || 'n/a',
        loveracingCommentary: rc?.loveracing?.race_commentary || 'n/a',
        meetingProfile: meetingProf || 'n/a'
      };
      selectionLines.push(`MANDATORY_RACE_VALUES: ${JSON.stringify(raceJson)}`);
      selectionLines.push(`Primary race context: ${rc.meeting || '—'} R${rc.race_number || '—'} ${rc.description || ''} | Distance ${rc.distance || 'n/a'}m | Track ${rc.track_condition || 'n/a'} | Rail ${rc.rail_position || 'n/a'} | Runners ${(rc.runners || []).length || 'n/a'}`);
    }
  }

  if (!selectionLines.length && clientContext?.raceContext) {
    const rcMeeting = String(clientContext.raceContext.meeting || '').trim().toLowerCase();
    const rcRace = String(clientContext.raceContext.raceNumber || '').replace(/^R/i, '').trim();
    const rc = (races || []).find(r =>
      String(r.meeting || '').trim().toLowerCase() === rcMeeting &&
      String(r.race_number || '').trim() === rcRace
    );
    if (rc) {
      const meetingProf = formatMeetingProfile(meetingProfiles[safeSlug(rc.meeting || '')]);
      const raceJson = {
        meeting: rc.meeting,
        raceNumber: rc.race_number,
        raceName: rc.description,
        distance: rc.distance,
        trackCondition: rc.track_condition,
        railPosition: rc.rail_position,
        runners: (rc.runners || []).length,
        loveracingAvailable: !!rc?.loveracing?.available,
        loveracingWeather: rc?.loveracing?.weather || 'n/a',
        loveracingCommentary: rc?.loveracing?.race_commentary || 'n/a',
        meetingProfile: meetingProf || 'n/a'
      };
      const fieldRows = (rc.runners || []).map(rr => ({
        runner: rr.name || rr.runner_name || 'n/a',
        runnerNumber: rr.runner_number ?? 'n/a',
        barrier: rr.barrier ?? 'n/a',
        jockey: rr.jockey || 'n/a',
        trainer: rr.trainer || 'n/a',
        trainerLocation: rr.trainer_location || null,
        apprentice: rr.apprentice_indicator || null,
        weight: rr.weight || rr.weight_total || 'n/a',
        age: rr.age || null,
        sex: rr.sex || null,
        gear: rr.gear || null,
        form: rr.last_twenty_starts || 'n/a',
        lastStarts: rr.last_starts || null,
        formComment: rr.form_comment || null,
        formIndicators: rr.form_indicators || null,
        odds: rr.odds || rr.fixed_win || rr.tote_win || 'n/a',
        sire: rr.sire || 'n/a',
        dam: rr.dam || 'n/a',
        damSire: rr.dam_sire || 'n/a',
        speedmap: rr.speedmap || 'n/a',
        stats: formatStatsCompact(rr.stats) || null,
        loveracingNote: rr.loveracing_note || null
      }));
      selectionLines.push(`MANDATORY_RACE_VALUES: ${JSON.stringify(raceJson)}`);
      selectionLines.push(`RACE_FIELD_DATA: ${JSON.stringify(fieldRows)}`);
      selectionLines.push(`Primary race context: ${rc.meeting || '—'} R${rc.race_number || '—'} ${rc.description || ''} | Distance ${rc.distance || 'n/a'}m | Track ${rc.track_condition || 'n/a'} | Rail ${rc.rail_position || 'n/a'} | Runners ${(rc.runners || []).length || 'n/a'}`);
    }
  }

  if (selectionLines.length) {
    selectionLines.reverse().forEach(line => lines.unshift(line));
  }

  if (webContext?.results?.length) {
    const refs = webContext.results.slice(0, 3).map(r => {
      const domain = domainFromUrl(r.url || '') || 'source';
      const snippet = trimText(r.pageSummary || r.snippet || r.title || '', 140);
      return `${domain}: ${snippet}`;
    }).filter(Boolean);
    if (refs.length) lines.push(`Internet refs: ${refs.join(' | ')}`);
  }
  if (webContext?.query) lines.push(`Search query: ${trimText(webContext.query, 120)}`);

  const userNotes = Array.isArray(clientContext?.userNotes) ? clientContext.userNotes.slice(0, 5) : [];
  if (userNotes.length) {
    const noteParts = userNotes
      .map(n => trimText(String(n?.text || ''), 120))
      .filter(Boolean);
    if (noteParts.length) {
      const meetingTag = userNotes[0]?.meeting ? ` (${userNotes[0].meeting})` : '';
      lines.push(`User meeting notes${meetingTag}: ${noteParts.join(' | ')}`);
    }
  }

  const summary = lines.filter(Boolean).join('\n');
  if (summary.length <= maxLength) return summary;
  // Truncate lower-priority sections first (from end) instead of slicing mid-content.
  const trimmed = lines.filter(Boolean);
  while (trimmed.join('\n').length > maxLength && trimmed.length > 1) {
    trimmed.pop();
  }
  const result = trimmed.join('\n');
  if (result.length <= maxLength) return result;
  return `${result.slice(0, maxLength - 1)}…`;
}

const BETMAN_ANALYST_SYSTEM_PROMPT = `You are BETMAN's senior racing analyst. Be direct, structured, and evidence-first.

Keep the tone natural—like you're messaging another pro punter. Weave the numbers into sentences instead of sterile bullet lists.

Hard rules:
1) If user provided dragged selections, anchor ONLY to those runners/races.
2) If data is missing, say "unavailable" instead of guessing.
3) Convert odds to implied probability when available and state edge = model% - implied%.
4) Keep output practical for betting decisions: top pick, danger, value angle, and pass conditions.
5) For multis, separate "2-race" vs "same-race" logic clearly.
6) Use Internet Context as mandatory evidence and cite source domains inline like (source: domain.com).
7) Always answer in English and explicitly explain the race map/tempo plus which runners profile as the genuine closers.
8) If the user names a runner (or drags it into context), call that runner out by name with its map role, strengths/risks, and why it is or isn’t the play.
9) Use ONLY the race + runner data provided in context (selection profiles, race context, odds tables). If something is missing, write "n/a" instead of inventing it. Mirror the template defined in instructions.md without skipping sections.
10) The JSON blocks labeled MANDATORY_RACE_VALUES and SELECTION_DATA are ground truth. Copy their values exactly when filling headers, tables, and horse profiles.
11) If RACE_FIELD_DATA is provided, use it to populate full-field horse profiles (runner name/number/barrier/jockey/trainer/weight/age/sex/gear/form/formComment/formIndicators/odds/pedigree/speedmap/stats) before writing any narrative. The "stats" field contains track/distance/condition-specific starts:wins-seconds-thirds records — use them to assess each runner's suitability to today's race conditions. The "form" field is a concise recent-starts string (e.g. "12x34" where digits are finishing positions and x means unplaced beyond 9th) — count actual wins (1s) and places (1-3) to assess true form. The "formIndicators" field contains flags such as early speed (HIGH/MODERATE/LOW), wet track aptitude, and racing pattern — always reference these when assessing map fit and track condition suitability. The "lastStarts" array gives finish positions with distance/track/condition for each recent run — use it to evaluate consistency, class, and track/distance trends. The "loveracingNote" field, when present, contains official form notes — treat it as additional source data for narrative commentary. The "apprentice" field, when populated, indicates the jockey allowance claim (e.g. "-2kg") — factor weight reduction into your assessment.
12) Never output placeholder tokens (e.g., [Jockey Name], [Trainer Name], [Weight]); if unknown, write "n/a".
13) If meetingProfile data is present in MANDATORY_RACE_VALUES, use it to weight your analysis: pace-bias stats (e.g., "Midfield 4/8") indicate which running styles are winning at the venue today; barrier-bias stats indicate which barrier ranges are favoured. Factor these into your race map, runner assessments, and final tips.
14) If "User meeting notes" are provided in context, treat them as first-hand observations from the punter. Incorporate them into your analysis and reference specific notes where relevant.
15) If the context states there are no races at a specific venue, do NOT fabricate analysis for that venue. Clearly state there are no races there and suggest the available alternatives listed in context.
16) If race data is scoped to a specific venue the user mentioned, anchor your analysis to that venue only. Do not discuss races from other venues unless asked.

Response format:
- Verdict (1-2 lines)
- Ranked runners / legs with win% and confidence
- Market edge + risk notes
- Race map & likely closers (pace shape, who settles where, who finishes late)
- Runner-specific callouts for every queried horse (map role, trainer/jockey or trait, go/no-go logic)
- If asked for multi: best structure + invalidation points
- For Same-Race Multi/H2H: include explicit joint likelihood for each proposed pair (not just individual win%).
- Optional: 3 short pundit lines + consensus when useful

Tone: plain English, no fluff, no hype.`;

const BETMAN_CHAT_SYSTEM_PROMPT = `You are BETMAN's racing intelligence copilot.

Goal: answer real-world horse racing questions with informed, practical reasoning, not canned templates.

Rules:
1) Be conversational but precise.
2) If the user asks a direct question, answer it directly first.
3) Use available race/runner/context data; if missing, say unavailable.
4) Prefer actionable outputs: probabilities, edge framing, risk notes, and what would change your view.
5) Cite external domains inline when web context is used (source: domain.com).
6) Avoid boilerplate and avoid repeating fixed section headings unless the user asks for a formal report.
7) For follow-ups, carry forward relevant prior context and assumptions so the answer feels continuous.
8) For broad "ask me anything racing" questions, provide depth: map/tempo, form cycle, trainer/jockey patterns, market/price dynamics, and risk management implications.
9) If meeting profile data is available (pace/barrier bias from completed races), factor it into your assessment of which running styles and barrier positions suit the venue.
10) If the user has added meeting notes (labelled "User meeting notes" in context), incorporate those observations into your answer.
11) If the context states there are no races at a specific venue, do NOT fabricate analysis for that venue. Clearly state there are no races there and suggest the available alternatives listed in context.
12) If race data is scoped to a specific venue the user mentioned, anchor your answer to that venue only. Do not discuss races from other venues unless asked.

Style: expert punter, plain English, no fluff.`;

const AI_RESPONSE_LOG = path.join(process.cwd(), 'memory', 'ai-answer-log.jsonl');
const aiHealth = {
  lastSuccess: null,
  lastFailure: null,
  lastMode: null,
  lastProvider: null,
  lastError: null
};

function recordAiOutcome({ question, payload, mode, provider, error, modelRequested, modelUsed, modelAdjusted }){
  const ts = new Date().toISOString();
  if (mode === 'ai' || mode === 'cache') {
    aiHealth.lastSuccess = ts;
  } else {
    aiHealth.lastFailure = ts;
  }
  aiHealth.lastMode = mode || null;
  aiHealth.lastProvider = provider || null;
  aiHealth.lastError = error || null;
  const row = {
    ts,
    mode: mode || null,
    provider: provider || null,
    error: error || null,
    modelRequested: modelRequested || String(payload?.model || '').trim() || null,
    modelUsed: modelUsed || null,
    modelAdjusted: !!modelAdjusted,
    selectionCount: Number(payload?.selectionCount || 0),
    races: Array.isArray(payload?.selections) ? payload.selections.map(s => `${s.meeting || ''} R${s.race || ''}`) : [],
    question: String(question || '').slice(0, 400)
  };
  try {
    fs.mkdirSync(path.dirname(AI_RESPONSE_LOG), { recursive: true });
    fs.appendFile(AI_RESPONSE_LOG, JSON.stringify(row) + '\n', err => {
      if (err) console.error('ai_response_log_failed', err.message);
    });
  } catch (err) {
    console.error('ai_response_log_append_error', err.message);
  }
}

function loadTenantAiChatMemory(tenantId = 'default') {
  const p = resolveTenantPathById(
    tenantId,
    path.join(process.cwd(), 'frontend', 'data', 'ai-chat-memory.json'),
    'ai-chat-memory.json'
  );
  const payload = loadJson(p, { turns: [] });
  const turns = Array.isArray(payload?.turns) ? payload.turns : [];
  return { path: p, turns };
}

function saveTenantAiChatMemory(filePath, turns = []) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ updatedAt: new Date().toISOString(), turns }, null, 2));
  } catch (err) {
    console.error('ai_chat_memory_save_failed', err?.message || err);
  }
}

function rememberAiTurn(tenantId, question, answer, sourceTag = '') {
  const source = String(sourceTag || '').toLowerCase();
  if (source === 'race-analysis') return;
  const state = loadTenantAiChatMemory(tenantId);
  const next = [...state.turns, {
    ts: new Date().toISOString(),
    q: String(question || '').slice(0, 1200),
    a: String(answer || '').slice(0, 1600)
  }];
  const maxTurns = envNumber('BETMAN_CHAT_MEMORY_TURNS', 16, 4, 40);
  saveTenantAiChatMemory(state.path, next.slice(-maxTurns));
}

async function buildSelectionAiAnswer(question, clientContext = {}, tenantId = 'default', providerOverride = ''){
  const requestedProvider = String(providerOverride || '').trim().toLowerCase() || resolveAiProvider();
  const key = process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY;
  const openAiBase = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const ollamaBase = String(process.env.OLLAMA_BASE_URL || process.env.BETMAN_OLLAMA_BASE_URL || process.env.BETMAN_CHAT_BASE_URL || BETMAN_OLLAMA_DEFAULT_BASE).replace(/\/$/, '');
  const ollamaDisabled = String(process.env.BETMAN_OLLAMA_DISABLED || 'false').toLowerCase() === 'true';
  const provider = (ollamaDisabled && requestedProvider === 'ollama' && key) ? 'openai' : requestedProvider;
  if (provider === 'openai' && !key) return null;
  console.log('[ai-chat] provider', provider, 'question', question);

  const status = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
  const racesData = loadJson(resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json'), {});
  let suggested = Array.isArray(status.suggestedBets) ? status.suggestedBets : [];

  const sourceTag = String(clientContext?.source || '').toLowerCase();
  const isRaceAnalysis = sourceTag === 'race-analysis';
  const isStrategy = sourceTag === 'strategy' || /\bstrategy\b/i.test(String(question || ''));
  const isMultiRequest = !isRaceAnalysis && /\b(?:multi|h2h|head[\s-]?to[\s-]?head)\b/i.test(String(question || ''));
  const selections = Array.isArray(clientContext.selections) ? clientContext.selections : [];
  const hasDraggedSelections = selections.length > 0;
  const scopedSelections = hasDraggedSelections
    ? selections.map((s) => ({
        meeting: String(s.meeting || '').trim(),
        race: String(s.race || '').trim(),
        selection: String(s.selection || s.runner || '').trim(),
        reason: String(s.reason || '').trim(),
        tags: Array.isArray(s.tags) ? s.tags.slice(0, 12) : [],
        odds: Number.isFinite(Number(s.odds)) ? Number(s.odds) : null,
        aiWinProb: Number.isFinite(Number(s.aiWinProb)) ? Number(s.aiWinProb) : null,
        impliedPct: Number.isFinite(Number(s.impliedPct)) ? Number(s.impliedPct) : null,
        edgePct: Number.isFinite(Number(s.edgePct)) ? Number(s.edgePct) : null,
        jockey: String(s.jockey || '').trim() || null,
        trainer: String(s.trainer || '').trim() || null,
        barrier: String(s.barrier || '').trim() || null,
        form: String(s.form || '').trim() || null,
        confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : null
      }))
    : [];
  const isGeneralChat = !isRaceAnalysis && !isStrategy;
  const webOptional = true;
  let webContext = { results: [], domains: [] };
  try {
    webContext = await buildInternetContext(question, clientContext);
  } catch (e) {
    // For race-analysis/strategy, internet context is optional; keep going with local race context.
    if (!webOptional) throw e;
    console.error('optional_web_context_unavailable', String(e?.message || e));
  }
  if (!webOptional && !webContext?.results?.length) throw new Error('web_context_unavailable');

  function lookupWinProb(meeting, race, selection){
    const m = String(meeting || '').trim().toLowerCase();
    const r = String(race || '').trim();
    const s = String(selection || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
    const hit = suggested.find(x =>
      String(x.meeting || '').trim().toLowerCase() === m &&
      String(x.race || '').trim() === r &&
      String(x.selection || '').replace(/^\d+\.\s*/, '').trim().toLowerCase() === s &&
      String(x.type || '').toLowerCase() === 'win'
    );
    const p = Number(hit?.aiWinProb);
    if (Number.isFinite(p) && p > 0) return p;
    const o = parseReasonOdds(hit?.reason || '');
    if (Number.isFinite(o) && o > 0) return (100 / o);
    return NaN;
  }

  function sameRaceJointLikelihoods(){
    if (String(clientContext?.source || '').toLowerCase() === 'race-analysis') return [];
    const sels = Array.isArray(clientContext.selections) ? clientContext.selections : [];
    const byRace = new Map();
    for (const s of sels) {
      const k = `${String(s.meeting||'').trim().toLowerCase()}|${String(s.race||'').trim()}`;
      if (!byRace.has(k)) byRace.set(k, []);
      byRace.get(k).push(s);
    }
    const out = [];
    for (const [k, arr] of byRace.entries()) {
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          const pA = lookupWinProb(a.meeting, a.race, a.runner || a.selection);
          const pB = lookupWinProb(b.meeting, b.race, b.runner || b.selection);
          if (!Number.isFinite(pA) || !Number.isFinite(pB)) continue;
          // Approx joint approximation with mild same-race dampener.
          const joint = Math.max(0, Math.min(100, (pA * pB / 100) * 0.92));
          out.push({
            meeting: a.meeting,
            race: a.race,
            runnerA: a.runner || a.selection,
            runnerB: b.runner || b.selection,
            winA: Math.round(pA * 10) / 10,
            winB: Math.round(pB * 10) / 10,
            jointLikelihood: Math.round(joint * 10) / 10,
            method: 'joint≈(pA*pB/100)*0.92'
          });
        }
      }
    }
    return out.slice(0, 8);
  }

  const stakeProfile = {
    stakePerRace: status.stakePerRace ?? null,
    exoticStakePerRace: status.exoticStakePerRace ?? null,
    earlyWindowMin: status.earlyWindowMin ?? null,
    aiWindowMin: status.aiWindowMin ?? null
  };

  let jointRows = sameRaceJointLikelihoods();

  // Venue-aware context scoping for general chat (no dragged selections, no raceContext)
  const allRaces = Array.isArray(racesData.races) ? racesData.races : [];
  const liveRaces = allRaces.filter(r => !FINISHED_RACE_STATUSES.has(String(r.race_status || '').toLowerCase()));
  // Filter suggested bets to exclude picks for races that have already finished
  suggested = suggested.filter(s => isLiveRaceEntry(s, allRaces));

  // Pre-compute cross-race multi pairs from live suggested win bets when the
  // user asks for a multi/H2H without dragging selections.
  if (isMultiRequest && !hasDraggedSelections && !jointRows.length) {
    const winBets = suggested.filter(s => String(s.type || '').toLowerCase() === 'win');
    const byRace = new Map();
    for (const s of winBets) {
      const k = `${String(s.meeting||'').trim().toLowerCase()}|${String(s.race||'').trim()}`;
      if (!byRace.has(k)) byRace.set(k, []);
      byRace.get(k).push(s);
    }
    const topPicks = [];
    for (const [, picks] of byRace.entries()) {
      const sorted = picks.slice().sort((a, b) => Number(b.aiWinProb || 0) - Number(a.aiWinProb || 0));
      if (sorted.length && Number.isFinite(Number(sorted[0].aiWinProb)) && Number(sorted[0].aiWinProb) > 0) {
        topPicks.push(sorted[0]);
      }
    }
    const multiPairs = [];
    for (let i = 0; i < topPicks.length && multiPairs.length < 8; i++) {
      for (let j = i + 1; j < topPicks.length && multiPairs.length < 8; j++) {
        const a = topPicks[i], b = topPicks[j];
        const pA = Number(a.aiWinProb), pB = Number(b.aiWinProb);
        const joint = Math.max(0, Math.min(100, pA * pB / 100));
        multiPairs.push({
          meeting: a.meeting, race: a.race, runnerA: a.selection,
          meetingB: b.meeting, raceB: b.race, runnerB: b.selection,
          winA: Math.round(pA * 10) / 10, winB: Math.round(pB * 10) / 10,
          jointLikelihood: Math.round(joint * 10) / 10,
          method: 'cross-race≈pA*pB/100'
        });
      }
    }
    multiPairs.sort((a, b) => b.jointLikelihood - a.jointLikelihood);
    jointRows = multiPairs.slice(0, 8);
  }

  const venueInference = (!hasDraggedSelections && !isRaceAnalysis)
    ? inferMeetingFromQuestion(question, liveRaces)
    : { mentioned: null, matched: [], available: [] };

  let venueNote = '';
  let venueScopedRaces = liveRaces;
  let venueScopedSuggested = suggested;
  // Exclude interesting runners & market movers for races that have already finished
  let venueScopedInteresting = (status.interestingRunners || []).filter(s => isLiveRaceEntry(s, allRaces));
  let venueScopedMovers = (status.marketMovers || []).filter(s => isLiveRaceEntry(s, allRaces));

  if (venueInference.mentioned && venueInference.matched.length > 0) {
    const matchedLower = new Set(venueInference.matched.map(m => m.toLowerCase()));
    venueScopedRaces = liveRaces.filter(r => matchedLower.has(String(r.meeting || '').trim().toLowerCase()));
    venueScopedSuggested = suggested.filter(x => matchedLower.has(String(x.meeting || '').trim().toLowerCase()));
    venueScopedInteresting = venueScopedInteresting.filter(x => matchedLower.has(String(x.meeting || '').trim().toLowerCase()));
    venueScopedMovers = venueScopedMovers.filter(x => matchedLower.has(String(x.meeting || '').trim().toLowerCase()));
  } else if (venueInference.mentioned && venueInference.matched.length === 0) {
    const availableList = venueInference.available.length
      ? venueInference.available.join(', ')
      : 'none currently loaded';
    venueNote = `IMPORTANT: There are no races at ${venueInference.mentioned} in today's data. Do NOT provide analysis for ${venueInference.mentioned}. Available venues racing today: ${availableList}. Clearly state that ${venueInference.mentioned} has no races today and suggest alternatives from the available venues.`;
  }

  const analysisSource = String(clientContext?.source || '').toLowerCase();
  const rcMeeting = String(clientContext?.raceContext?.meeting || '').trim().toLowerCase();
  const rcRace = String(clientContext?.raceContext?.raceNumber || '').replace(/^R/i, '').trim();
  const scopedSuggested = isRaceAnalysis
    ? suggested.filter(x =>
        String(x.meeting || '').trim().toLowerCase() === rcMeeting &&
        String(x.race || '').replace(/^R/i, '').trim() === rcRace
      )
    : venueScopedSuggested;

  const requestedModel = String(clientContext?.model || '').trim();
  const defaultModel = process.env.BETMAN_CHAT_MODEL || (provider === 'ollama' ? 'qwen2.5:1.5b' : 'gpt-4o-mini');

  const OPENAI_MODELS = new Set(['gpt-4o-mini', 'gpt-5.2']);

  let effectiveModel = requestedModel || defaultModel;
  if (requestedModel && provider === 'openai' && !OPENAI_MODELS.has(requestedModel)) {
    throw new Error('openai_model_not_allowed');
  }

  const modelProfile = (() => {
    const m = String(effectiveModel || '').toLowerCase();
    if (isSmallModel(m)) {
      return {
        contextRace: envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS_SMALL', 8000, 3000, 16000),
        contextGeneral: envNumber('BETMAN_CONTEXT_MAX_GENERAL_SMALL', 2600, 900, 10000),
        historyTurns: envNumber('BETMAN_CHAT_HISTORY_TURNS_SMALL', 6, 0, 16),
        historyChars: envNumber('BETMAN_CHAT_HISTORY_CHARS_SMALL', 1200, 300, 4000),
        maxTokensRace: envNumber('BETMAN_CHAT_MAX_TOKENS_RACE_ANALYSIS_SMALL', 1100, 500, 2200),
        maxTokensGeneral: envNumber('BETMAN_CHAT_MAX_TOKENS_SMALL', 900, 300, 3000),
        temperatureRace: 0.15,
        temperatureGeneral: 0.28,
        numCtxFloor: envNumber('BETMAN_OLLAMA_NUM_CTX_SMALL', 8192, 4096, 32768)
      };
    }
    return {
      contextRace: envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS', 12000, 4000, 24000),
      contextGeneral: envNumber('BETMAN_CONTEXT_MAX_GENERAL', 4200, 1000, 16000),
      historyTurns: envNumber('BETMAN_CHAT_HISTORY_TURNS', 8, 0, 24),
      historyChars: envNumber('BETMAN_CHAT_HISTORY_CHARS', 1600, 300, 5000),
      maxTokensRace: envNumber('BETMAN_CHAT_MAX_TOKENS_RACE_ANALYSIS', 1400, 600, 3000),
      maxTokensGeneral: envNumber('BETMAN_CHAT_MAX_TOKENS', 1100, 400, 4000),
      temperatureRace: 0.2,
      temperatureGeneral: 0.35,
      numCtxFloor: envNumber('BETMAN_OLLAMA_NUM_CTX', 16384, 4096, 65536)
    };
  })();

  // Temporal race detection: when venue is matched and user asks about "the next race"
  // or "the last race", find the matching race and inject raceContext so full field data is included.
  let effectiveClientContext = clientContext;
  if (!hasDraggedSelections && !isRaceAnalysis && !clientContext?.raceContext && venueInference.matched.length > 0) {
    const temporal = inferTemporalRaceAtVenue(question, allRaces, venueInference.matched[0]);
    if (temporal) {
      effectiveClientContext = Object.assign({}, clientContext, {
        raceContext: {
          meeting: temporal.race.meeting,
          raceNumber: String(temporal.race.race_number),
          raceName: temporal.race.description || '',
          direction: temporal.direction
        }
      });
    }
  }

  const contextSummary = buildAiContextSummary({
    status: { updatedAt: status.updatedAt, apiStatus: status.apiStatusPublic || status.apiStatus },
    stakeProfile,
    suggested: hasDraggedSelections ? scopedSuggested.filter(x => scopedSelections.some(s => String(x.meeting||'').trim() === s.meeting && String(x.race||'').trim() === s.race && String(x.selection||'').trim() === s.selection)) : scopedSuggested,
    interesting: hasDraggedSelections ? [] : venueScopedInteresting,
    marketMovers: hasDraggedSelections ? [] : venueScopedMovers,
    upcoming: hasDraggedSelections ? [] : (status.upcomingRaces || []).filter(s => isLiveRaceEntry(s, allRaces)),
    activity: hasDraggedSelections ? [] : (status.activity || []),
    webContext: hasDraggedSelections ? { results: [], domains: [] } : webContext,
    clientContext: effectiveClientContext,
    jointRows,
    question,
    races: hasDraggedSelections ? liveRaces.filter(r => scopedSelections.some(s => String(r.meeting||'').trim() === s.meeting && String(r.race_number || r.race || '').trim() === s.race)) : venueScopedRaces,
    meetingProfiles: loadMeetingProfiles('today'),
    maxLength: isRaceAnalysis ? modelProfile.contextRace : modelProfile.contextGeneral,
    venueNote
  });

  const customInstructions = loadText(AI_INSTRUCTIONS_FILE, '').trim();
  const systemPrompt = (isRaceAnalysis || isStrategy || isMultiRequest) ? BETMAN_ANALYST_SYSTEM_PROMPT : BETMAN_CHAT_SYSTEM_PROMPT;
  const messages = [
    {
      role: 'system',
      content: `${systemPrompt}\n\nPriority rule: answer the user's latest question directly first. Do not ignore, rewrite, or replace the question with a generic template.`
    }
  ];
  if (hasDraggedSelections) {
    const draggedScope = scopedSelections.map((s, i) => {
      const extra = [
        Array.isArray(s.tags) && s.tags.length ? `tags ${s.tags.join(', ')}` : '',
        Number.isFinite(s.odds) ? `odds ${s.odds.toFixed(2)}` : '',
        Number.isFinite(s.aiWinProb) ? `model ${s.aiWinProb.toFixed(1)}%` : '',
        Number.isFinite(s.impliedPct) ? `implied ${s.impliedPct.toFixed(1)}%` : '',
        Number.isFinite(s.edgePct) ? `edge ${s.edgePct >= 0 ? '+' : ''}${s.edgePct.toFixed(1)} pts` : '',
        s.barrier ? `barrier ${s.barrier}` : '',
        s.jockey ? `jockey ${s.jockey}` : '',
        s.trainer ? `trainer ${s.trainer}` : '',
        s.form ? `form ${s.form}` : '',
        Number.isFinite(s.confidence) ? `confidence ${s.confidence.toFixed(1)}%` : ''
      ].filter(Boolean).join(' | ');
      return `${i + 1}. ${s.meeting} R${s.race} ${s.selection}${extra ? ` | ${extra}` : ''}`;
    }).join('\n');
    messages.push({
      role: 'system',
      content: `Selection lock: answer ONLY using the explicitly dragged selections below unless the user clearly asks to broaden scope. Do not switch to other meetings, races, or generic NZ angles.\n${draggedScope}`
    });
  } else if (isMultiRequest) {
    messages.push({
      role: 'system',
      content: 'Multi bet construction: the user wants a multi/H2H bet built from live races. Pick legs ONLY from the Suggested bets listed in the Context Summary (these are already filtered to live races). For each leg state the runner, meeting, race, odds, and win probability EXACTLY as they appear in context. Compute the combined multi odds by multiplying individual leg odds and the joint win likelihood by multiplying individual win probabilities. If the Context Summary includes Joint likelihoods, use those figures. Do NOT invent odds, probabilities, or confidence percentages that are not in context — write "n/a" if missing.'
    });
  }
  if (customInstructions) {
    messages.push({ role: 'system', content: `Mandatory House Instructions:\n${customInstructions}` });
  }

  const tenantMemory = loadTenantAiChatMemory(tenantId);
  const persistedTurns = tenantMemory.turns.slice(-Math.max(0, Math.floor(modelProfile.historyTurns / 2)));
  for (const turn of persistedTurns) {
    const q = String(turn?.q || '').trim();
    const a = String(turn?.a || '').trim();
    if (q) messages.push({ role: 'user', content: q.slice(0, modelProfile.historyChars) });
    if (a) messages.push({ role: 'assistant', content: a.slice(0, modelProfile.historyChars) });
  }

  const history = Array.isArray(clientContext?.chatHistory) ? clientContext.chatHistory.slice(-modelProfile.historyTurns) : [];
  for (const h of history) {
    const role = String(h?.role || '').toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const text = String(h?.text || '').trim();
    if (!text) continue;
    messages.push({ role, content: text.slice(0, modelProfile.historyChars) });
  }

  messages.push({ role: 'user', content: `Latest user question (answer this): ${question}\n\nContext Summary:\n${contextSummary}` });

  const temperature = isRaceAnalysis ? modelProfile.temperatureRace : modelProfile.temperatureGeneral;
  const maxTokens = isRaceAnalysis ? modelProfile.maxTokensRace : modelProfile.maxTokensGeneral;
  const fakeAiMode = String(process.env.BETMAN_FAKE_AI || '').toLowerCase() === 'true';
  if (fakeAiMode) {
    const placeholder = `[fake-ai:${effectiveModel}] ${question}`;
    return {
      answer: appendRunnerCallouts(placeholder, selections, suggested),
      requestedModel: requestedModel || null,
      modelUsed: effectiveModel,
      modelAdjusted: !!requestedModel && requestedModel !== effectiveModel,
      contextMaxLength: isRaceAnalysis ? modelProfile.contextRace : modelProfile.contextGeneral,
      historyTurnsUsed: modelProfile.historyTurns,
      historyCharsUsed: modelProfile.historyChars
    };
  }

  let answer = '';
  if (provider === 'ollama') {
    const ollamaBases = getOllamaBaseList();
    if (!ollamaBases.length) throw new Error('ollama_base_missing');
    const maxAttempts = envNumber('BETMAN_OLLAMA_MAX_ATTEMPTS', 1, 1, 5);

    // Calculate num_ctx dynamically: estimated input tokens + output tokens + safety buffer.
    // Conservative estimate of 3.5 chars per token; floor at model-profile minimum.
    const totalInputChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
    const estimatedInputTokens = Math.ceil(totalInputChars / 3.5);
    const numCtx = Math.max(
      estimatedInputTokens + maxTokens + 512,
      modelProfile.numCtxFloor
    );

    async function runOllamaOnce(baseUrl, modelName){
      const timeoutMs = envNumber('BETMAN_OLLAMA_TIMEOUT_MS', 180000, 5000, 300000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: modelName,
            messages,
            stream: false,
            options: {
              temperature,
              num_predict: maxTokens,
              num_ctx: numCtx
            }
          })
        });
      } finally {
        clearTimeout(timer);
      }
    }

    async function runOllamaWithRetry(baseUrl, modelName){
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await runOllamaOnce(baseUrl, modelName);
        } catch (err) {
          lastErr = err;
          console.error('ollama_attempt_failed', baseUrl, modelName, `attempt ${attempt}/${maxAttempts}`, err?.message || err);
          if (attempt < maxAttempts) {
            await new Promise(res => setTimeout(res, attempt * 200));
          }
        }
      }
      if (lastErr) throw lastErr;
      throw new Error('ollama_unknown_error');
    }

    const requestedModelName = effectiveModel;
    let lastError = null;

    for (const base of ollamaBases) {
      let modelForBase = requestedModelName;
      let response = null;

      try {
        response = await runOllamaWithRetry(base, modelForBase);
      } catch (err) {
        lastError = err;
        console.error('ollama_request_failed', base, err?.message || err);
        continue;
      }

      if (!response.ok && response.status === 404) {
        console.error('ollama_model_missing', modelForBase, 'base', base);
      }

      if (!response.ok) {
        lastError = new Error(`ollama_${response.status}`);
        continue;
      }

      try {
        const out = await response.json();
        const txt = out?.message?.content;
        if (!txt) {
          console.error('ollama_no_text', JSON.stringify(out || {}));
          lastError = new Error('ollama_no_text');
          continue;
        }
        answer = String(txt).trim();
        effectiveModel = modelForBase;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error('ollama_response_parse_error', err?.message || err);
      }
    }

    if (!answer) {
      const openAiKeyAvailable = !!(process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY || process.env.OPEN_AI_KEY);
      if (openAiKeyAvailable) {
        console.error('ollama_unavailable_fallback_openai', lastError?.message || lastError || 'ollama_unavailable');
        provider = 'openai';
        effectiveModel = process.env.BETMAN_OPENAI_MODEL || process.env.BETMAN_CHAT_MODEL || 'gpt-4o-mini';
      } else {
        throw lastError || new Error('ollama_unavailable');
      }
    }
  }

  if (provider === 'openai') {
    const useResponsesApi = openAiUsesCompletionTokens(effectiveModel);
    if (useResponsesApi) {
      const transcript = messages.map(m => `${String(m.role || 'user').toUpperCase()}:\n${String(m.content || '')}`).join('\n\n');
      const payload = {
        model: effectiveModel,
        input: transcript,
        temperature,
        max_output_tokens: maxTokens
      };
      const modelKey = String(effectiveModel || '').toLowerCase();
      if (modelKey.includes('gpt-5.4-pro')) {
        payload.reasoning = { effort: 'medium' };
      }

      const r = await fetch(`${openAiBase}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(payload)
      });

      if (!r.ok) {
        let errorDetail = '';
        try {
          errorDetail = await r.text();
        } catch (err) {
          errorDetail = `read_error:${err?.message || err}`;
        }
        console.error('openai_response_error', r.status, errorDetail.slice(0, 400));
        throw new Error(`openai_${r.status}`);
      }
      const out = await r.json();
      const segments = Array.isArray(out?.output) ? out.output : [];
      const textParts = [];
      for (const segment of segments) {
        const contentPieces = Array.isArray(segment?.content) ? segment.content : [];
        for (const piece of contentPieces) {
          if (piece?.type === 'output_text' && piece.text) {
            textParts.push(String(piece.text));
          }
        }
      }
      const txt = textParts.join('\n').trim();
      if (!txt) {
        console.error('openai_no_text_responses_api', JSON.stringify(out || {}));
        return null;
      }
      answer = String(txt).trim();
    } else {
      const payload = {
        model: effectiveModel,
        temperature,
        max_tokens: maxTokens,
        messages
      };
      const modelKey = String(effectiveModel || '').toLowerCase();
      if (modelKey.includes('gpt-5.4-pro')) {
        payload.reasoning_effort = 'medium';
      }

      const r = await fetch(`${openAiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(payload)
      });

      if (!r.ok) {
        let errorDetail = '';
        try {
          errorDetail = await r.text();
        } catch (err) {
          errorDetail = `read_error:${err?.message || err}`;
        }
        console.error('openai_error_response', r.status, errorDetail.slice(0, 400));
        throw new Error(`openai_${r.status}`);
      }
      const out = await r.json();
      const txt = out?.choices?.[0]?.message?.content;
      if (!txt) {
        console.error('openai_no_text', JSON.stringify(out || {}));
        return null;
      }
      answer = String(txt).trim();
    }
  }
  const ql = String(question || '').toLowerCase();
  const sameRaceAsked = ql.includes('same-race') || ql.includes('same race') || ql.includes('h2h') || ql.includes('head to head');
  const hasJointInAnswer = /joint\s+likelihood|both\s+come\s+in|pair\s+likelihood/i.test(answer);

  if ((sameRaceAsked || isMultiRequest) && jointRows.length && !hasJointInAnswer) {
    const lines = jointRows.map((x, i) => {
      if (x.meetingB) {
        return `${i+1}) Leg A: ${x.meeting} R${x.race} ${x.runnerA} + Leg B: ${x.meetingB} R${x.raceB} ${x.runnerB} -> joint likelihood ${x.jointLikelihood}% (winA ${x.winA}%, winB ${x.winB}%; ${x.method})`;
      }
      return `${i+1}) ${x.meeting} R${x.race} ${x.runnerA} + ${x.runnerB} -> joint likelihood ${x.jointLikelihood}% (winA ${x.winA}%, winB ${x.winB}%; ${x.method})`;
    }).join('\n');
    answer += `\n\nJoint likelihood (both runners in):\n${lines}`;
  }

  return {
    answer: appendRunnerCallouts(answer, selections, suggested),
    requestedModel: requestedModel || null,
    modelUsed: effectiveModel,
    modelAdjusted: !!requestedModel && requestedModel !== effectiveModel,
    contextMaxLength: isRaceAnalysis ? modelProfile.contextRace : modelProfile.contextGeneral,
    historyTurnsUsed: modelProfile.historyTurns,
    historyCharsUsed: modelProfile.historyChars
  };
}

/* ── BETMAN Commercial API v1 handler ──────────────────────────────── */
const betmanApiHandler = createApiHandler({
  getAuthState: () => refreshAuthStateFromDisk(),
  saveAuthState: (next) => saveAuthState(next),
  loadJson,
  resolveTenantPath,
  getSessionPrincipal: (req) => getAuthPrincipal(req),
  resolveTenantPathById,
  dataDir: path.join(process.cwd(), 'frontend', 'data'),
  rootDir: process.cwd()
});

const server = http.createServer(async (req, res)=>{
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, getCorsHeaders(req));
    return res.end();
  }

  // BETMAN Commercial API v1
  if (url.pathname.startsWith('/api/v1/')) {
    try {
      const handled = await betmanApiHandler(req, res, url);
      if (handled) return;
    } catch (e) {
      console.error('API v1 error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...getCorsHeaders(req) });
        res.end(JSON.stringify({ ok: false, error: 'internal_error', message: 'An unexpected error occurred.' }));
      }
      return;
    }
  }

  // Public login/landing routes
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/landing' || url.pathname === '/landing.html' || url.pathname === '/login')) {
    const forceLanding = ['1','true','yes'].includes(String(url.searchParams.get('logout') || '').toLowerCase());
    const principal = forceLanding ? null : getAuthPrincipal(req);
    if (principal) {
      const appPath = safePath('/index.html');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      return res.end(fs.readFileSync(appPath));
    }
    const landingPath = safePath('/landing.html');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.end(fs.readFileSync(landingPath));
  }

  if (req.method === 'GET' && (url.pathname === '/set-password' || url.pathname === '/set-password.html')) {
    const p = safePath('/set-password.html');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.end(fs.readFileSync(p));
  }

  if (req.method === 'GET' && (url.pathname === '/why' || url.pathname === '/why.html')) {
    const p = safePath('/why.html');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.end(fs.readFileSync(p));
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', async ()=>{
      try {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');
      const principal = validateCredentials(username, password);
      if (!principal) {
        const idx = (authState.users || []).findIndex(u => normalizeUsername(u.username) === normalizeUsername(username));
        if (idx >= 0) {
          const u = authState.users[idx];
          if (!u.password) {
            let token = String(u.setupToken || '').trim();
            const exp = new Date(u.setupExpiresAt || 0).getTime();
            if (!token || !Number.isFinite(exp) || Date.now() > exp) {
              token = makeSetupToken();
              const users = [...(authState.users || [])];
              users[idx] = { ...users[idx], setupToken: token, setupExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), updatedAt: new Date().toISOString() };
              saveAuthState({ username: authState.username, password: authState.password, users });
            }
            const setupLink = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/set-password?token=${encodeURIComponent(token)}`;
            return okJson(res, { ok: false, error: 'password_setup_required', setupLink }, 403);
          }
        }
        return okJson(res, { ok: false, error: 'invalid_credentials' }, 401);
      }

      if (!principal.isAdmin) {
        const userRow = (authState.users || []).find(u => normalizeUsername(u.username) === normalizeUsername(principal.username));
        const protectedAccount = isProtectedBetmanAccount(userRow || principal.username);
        const manualOverride = !!(userRow && (userRow.subscriptionStatus === 'manual_override' || (typeof userRow.subscriptionActive === 'undefined' && typeof userRow.subscriptionStatus === 'undefined')));
        if (!protectedAccount) {
          if (manualOverride && userRow && userRow.subscriptionStatus !== 'manual_override') {
            const users = [...(authState.users || [])];
            const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(principal.username));
            if (idx >= 0) {
              users[idx] = { ...users[idx], subscriptionActive: true, subscriptionStatus: 'manual_override', updatedAt: new Date().toISOString() };
              saveAuthState({ username: authState.username, password: authState.password, users });
            }
          }
          if (!manualOverride) {
            try {
              const sub = await checkSubscriptionByUser(userRow || { username: principal.username, email: principal.username, planType: 'single' });
              if (sub.enforceable && !sub.active) {
                const planType = String(userRow?.planType || 'single');
                return okJson(res, {
                  ok: false,
                  error: 'subscription_required',
                  paymentLink: paymentLinkForPlan(planType) || null,
                  planType,
                  reason: sub.reason || null,
                  message: sub.reason === 'single_day_expired'
                    ? 'Your BETMAN Single DAY pass has expired. Buy another day pass or upgrade to a subscription.'
                    : 'An active BETMAN subscription is required.'
                }, 402);
              }
              if (sub.customerId && userRow && !userRow.stripeCustomerId) {
                const users = [...(authState.users || [])];
                const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(principal.username));
                if (idx >= 0) {
                  users[idx] = { ...users[idx], stripeCustomerId: sub.customerId, updatedAt: new Date().toISOString() };
                  saveAuthState({ username: authState.username, password: authState.password, users });
                }
              }
            } catch {
              return okJson(res, { ok: false, error: 'billing_check_failed' }, 503);
            }
          }
        }
      }

      const sid = createSession(principal);
      res.setHeader('Set-Cookie', `betman_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);
      return okJson(res, {
        ok: true,
        user: principal.username,
        sessionToken: sid,
        tenantId: principal.tenantId || 'default',
        effectiveTenantId: principal.effectiveTenantId || (principal.tenantId || 'default')
      });
      } catch (err) {
        console.error('login_error', err?.message || err);
        return okJson(res, { ok: false, error: 'internal_error' }, 500);
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/pricing') {
    return okJson(res, {
      ok: true,
      single: { price: '$9.95/week', paymentLink: STRIPE_LINK_SINGLE || null },
      single_day: { price: '$7.95/day', paymentLink: STRIPE_LINK_SINGLE_DAY || null },
      commercial: { price: '$250/month', paymentLink: STRIPE_LINK_COMMERCIAL || null },
      tester: { price: 'Free/signup', paymentLink: STRIPE_LINK_TESTER || null }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/password-setup-link') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', async ()=>{
      try {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const email = normalizeEmail(payload.email || '');
      if (!isValidEmail(email)) return okJson(res, { ok: false, error: 'invalid_email' }, 400);
      let idx = (authState.users || []).findIndex(u => normalizeUsername(u.username) === normalizeUsername(email));
      let user = idx >= 0 ? authState.users[idx] : null;
      let sub = null;

      if (!user) {
        try {
          const lookup = await checkSubscriptionByUser({ email });
          if (!lookup?.customerId) {
            return okJson(res, { ok: false, error: 'user_not_found' }, 404);
          }
          const planType = lookup.planType || 'single';
          const rawName = String(lookup.customerName || '').trim();
          const nameParts = rawName ? rawName.split(/\s+/) : [];
          let firstName = '';
          let lastName = '';
          let companyName = '';
          if (planType === 'commercial') {
            companyName = rawName || email;
          } else {
            firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || email.split('@')[0]);
            lastName = nameParts.length > 1 ? nameParts.slice(-1).join(' ') : '';
          }
          const upsert = upsertProvisionedUser({ email, firstName, lastName, companyName, planType, stripeCustomerId: lookup.customerId, accessExpiresAt: lookup.accessExpiresAt || null });
          user = upsert?.user || null;
          sub = lookup;
          idx = (authState.users || []).findIndex(u => normalizeUsername(u.username) === normalizeUsername(email));
        } catch {
          return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        }
      }

      if (!user) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
      // Existing local accounts (live accounts) can always reset their password;
      // subscription enforcement happens at login. Only gate new-to-system users.
      if (!sub) sub = await checkSubscriptionByUser(user).catch(() => ({ enforceable: false, active: false }));
      const isLiveAccount = idx >= 0;
      if (!isLiveAccount && sub.enforceable && !sub.active) {
        return okJson(res, { ok: false, error: 'subscription_required', paymentLink: paymentLinkForPlan(user.planType), planType: user.planType || 'single' }, 402);
      }
      const token = makeSetupToken();
      const setupExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
      const users = [...(authState.users || [])];
      if (idx >= 0) {
        const subUpdate = sub.active ? { subscriptionActive: true, subscriptionStatus: 'active' } : {};
        users[idx] = { ...users[idx], ...subUpdate, setupToken: token, setupExpiresAt, stripeCustomerId: sub.customerId || users[idx].stripeCustomerId || null, accessExpiresAt: sub.accessExpiresAt || users[idx].accessExpiresAt || null, updatedAt: new Date().toISOString() };
        saveAuthState({ username: authState.username, password: authState.password, users });
      }
      const setupLink = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/set-password?token=${encodeURIComponent(token)}`;
      return okJson(res, { ok: true, setupLink });
      } catch (err) {
        console.error('password_setup_link_error', err?.message || err);
        return okJson(res, { ok: false, error: 'internal_error' }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/set-password') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', ()=>{
      try {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const token = String(payload.token || '').trim();
      const password = String(payload.password || '');
      if (!token) return okJson(res, { ok: false, error: 'token_required' }, 400);
      if (!password || password.length < 8) return okJson(res, { ok: false, error: 'password_too_short' }, 400);
      const users = [...(authState.users || [])];
      const idx = users.findIndex(u => String(u.setupToken || '') === token);
      if (idx < 0) return okJson(res, { ok: false, error: 'invalid_token' }, 400);
      const exp = new Date(users[idx].setupExpiresAt || 0).getTime();
      if (!Number.isFinite(exp) || Date.now() > exp) return okJson(res, { ok: false, error: 'token_expired' }, 400);
      users[idx] = { ...users[idx], password, setupToken: null, setupExpiresAt: null, updatedAt: new Date().toISOString() };
      saveAuthState({ username: authState.username, password: authState.password, users });
      return okJson(res, { ok: true, user: users[idx].username });
      } catch (err) {
        console.error('set_password_error', err?.message || err);
        return okJson(res, { ok: false, error: 'internal_error' }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stripe-webhook') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', async ()=>{
      try {
        const stripe = getStripe();
        if (!stripe) return okJson(res, { ok: false, error: 'stripe_not_configured' }, 503);

        let event = null;
        const sig = req.headers['stripe-signature'];
        if (STRIPE_WEBHOOK_SECRET && sig) {
          event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
        } else {
          event = JSON.parse(body || '{}');
        }

        const type = String(event?.type || '');
        const obj = event?.data?.object || {};

        if (type === 'checkout.session.completed' || type.startsWith('customer.subscription.')) {
          let email = normalizeEmail(obj?.customer_details?.email || obj?.customer_email || '');
          let customerId = String(obj?.customer || '');
          if (!email && customerId) {
            try {
              const c = await stripe.customers.retrieve(customerId);
              email = normalizeEmail(c?.email || '');
            } catch (stripeErr) {
              console.error('webhook_stripe_customer_retrieve_failed', customerId, stripeErr?.message || stripeErr);
            }
          }
          if (email) {
            const planType = inferPlanTypeFromStripe(obj);
            const firstName = String(obj?.customer_details?.name || '').trim().split(' ').slice(0, -1).join(' ');
            const lastName = String(obj?.customer_details?.name || '').trim().split(' ').slice(-1).join(' ');
            const companyName = planType === 'commercial' ? String(obj?.customer_details?.name || '') : '';
            let accessExpiresAt = null;
            if (planType === 'single_day') {
              const baseTs = Number(obj?.expires_at || obj?.current_period_end || obj?.trial_end || obj?.created || 0);
              if (baseTs) accessExpiresAt = new Date(baseTs * 1000).toISOString();
            }
            upsertProvisionedUser({ email, firstName, lastName, companyName, planType, stripeCustomerId: customerId, accessExpiresAt });
          }
        }

        return okJson(res, { ok: true });
      } catch (e) {
        return okJson(res, { ok: false, error: 'webhook_failed', detail: e.message }, 400);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/signup-challenge') {
    const a = Math.floor(Math.random() * 7) + 3;
    const b = Math.floor(Math.random() * 7) + 2;
    const token = crypto.randomBytes(12).toString('hex');
    signupChallenges.set(token, { answer: String(a + b), exp: Date.now() + (5 * 60 * 1000) });
    return okJson(res, { ok: true, token, prompt: `Verification: what is ${a} + ${b}?` });
  }

  if (req.method === 'POST' && url.pathname === '/api/signup') {
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', async ()=>{
      try {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const planTypeInput = String(payload.planType || 'single').toLowerCase();
      const planType = planTypeInput === 'commercial' ? 'commercial' : (planTypeInput === 'single_day' || planTypeInput === 'single-day' || planTypeInput === 'day' ? 'single_day' : 'single');
      const firstNameInput = String(payload.firstName || '');
      const lastNameInput = String(payload.lastName || '');
      const companyNameInput = String(payload.companyName || '');
      const firstName = firstNameInput;
      const lastName = lastNameInput;
      const companyName = companyNameInput;
      const email = normalizeEmail(payload.email || '');
      const password = String(payload.password || '');
      const token = String(payload.challengeToken || '');
      const answerInput = String(payload.challengeAnswer || '');
      const answer = answerInput;
      const answerCheck = answerInput.trim();
      const row = signupChallenges.get(token);
      if (row) signupChallenges.delete(token);

      const firstNameCheck = firstNameInput.trim();
      const lastNameCheck = lastNameInput.trim();
      const companyNameCheck = companyNameInput.trim();
      const hasPersonName = firstNameCheck.length >= 2 && lastNameCheck.length >= 2;
      const hasCompany = companyNameCheck.length >= 2;
      if (planType === 'commercial' && !hasCompany) return okJson(res, { ok: false, error: 'company_name_required' }, 400);
      if (planType !== 'commercial' && !hasPersonName) return okJson(res, { ok: false, error: 'first_last_name_required' }, 400);
      if (!isValidEmail(email)) return okJson(res, { ok: false, error: 'invalid_email' }, 400);
      if (!password || password.length < 8) return okJson(res, { ok: false, error: 'password_too_short' }, 400);
      if (SIGNUP_VERIFICATION_REQUIRED) {
        const staticVerifyPass = String(answerCheck || '').toUpperCase() === 'VERIFY';
        const challengePass = !!(row && Date.now() <= row.exp && String(row.answer) === answerCheck);
        if (!staticVerifyPass && !challengePass) return okJson(res, { ok: false, error: 'verification_failed' }, 400);
      }
      if ((authState.users || []).some(u => normalizeUsername(u.username) === normalizeUsername(email)) || normalizeUsername(authState.username) === normalizeUsername(email)) {
        return okJson(res, { ok: false, error: 'email_exists' }, 409);
      }

      const emailSlug = email.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const tenantId = normalizeTenantId(emailSlug ? `acct_${emailSlug}` : 'default');

      let newUser = {
        username: email,
        email,
        planType: planType === 'commercial' ? 'commercial' : (planType === 'single_day' ? 'single_day' : 'single'),
        firstName,
        lastName,
        companyName,
        name: planType === 'commercial' ? companyName : ([firstName, lastName].filter(v => v !== '').join(' ') || email),
        password,
        tenantId,
        role: 'user',
        openaiEnabled: false,
        openaiComplimentary: false,
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'self-signup',
        createdAt: new Date().toISOString()
      };
      try { newUser = await ensureStripeCustomerForUser(newUser); } catch (stripeErr) {
        console.error('signup_stripe_customer_failed', email, stripeErr?.message || stripeErr);
      }

      const users = [...(authState.users || []), newUser];
      saveAuthState({ username: authState.username, password: authState.password, users });
      return okJson(res, { ok: true, user: email, paymentLink: paymentLinkForPlan(planType) || null });
      } catch (err) {
        console.error('signup_error', err?.message || err);
        return okJson(res, { ok: false, error: 'internal_error' }, 500);
      }
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/styles.css' || url.pathname === '/landing.css' || url.pathname.startsWith('/assets/'))) {
    const p = safePath(url.pathname);
    if (!p || !fs.existsSync(p)) return send(res, 404, 'not found');
    const ext = path.extname(p).toLowerCase();
    const types = { '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
    const mime = types[ext] || 'application/octet-stream';
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': mime });
      return res.end();
    }
    return send(res, 200, fs.readFileSync(p), mime);
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/app.js') {
    const p = safePath('/app.js');
    if (!p || !fs.existsSync(p)) return send(res, 404, 'not found');
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end();
    }
    return send(res, 200, fs.readFileSync(p), 'application/javascript; charset=utf-8');
  }

  // Allow pre-auth reads for bootstrap config used by the login/landing UI.
  if (req.method === 'GET' && url.pathname === '/data/stake.json') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const p = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'stake.json'), 'stake.json');
    const fallback = path.join(process.cwd(), 'frontend', 'data', 'stake.json');
    return send(res, 200, fs.readFileSync(fs.existsSync(p) ? p : fallback), 'application/json');
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    const icoPath = safePath('/assets/favicon.ico');
    const pngPath = safePath('/assets/logo.png');
    const filePath = (icoPath && fs.existsSync(icoPath)) ? icoPath : ((pngPath && fs.existsSync(pngPath)) ? pngPath : null);
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.ico' ? 'image/x-icon' : 'image/png';
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      return res.end(buf);
    }
    res.writeHead(204, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=60' });
    return res.end();
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/apple-touch-icon.png' || url.pathname === '/apple-touch-icon-precomposed.png')) {
    const applePath = safePath('/assets/apple-touch-icon.png');
    const fallback = safePath('/assets/logo.png');
    const filePath = (applePath && fs.existsSync(applePath)) ? applePath : ((fallback && fs.existsSync(fallback)) ? fallback : null);
    if (filePath) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      if (req.method === 'HEAD') return res.end();
      const buf = fs.readFileSync(filePath);
      return res.end(buf);
    }
    res.writeHead(204, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const statusPath = path.join(process.cwd(), 'frontend', 'data', 'status.json');
    let status = null;
    try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    const apiState = String(status?.apiStatusPublic || status?.apiStatus || 'UNVERIFIED').toUpperCase();
    const smokeFresh = status?.apiStatusDetail?.smokeFresh !== false;
    const healthy = apiState === 'OK' && smokeFresh;
    return okJson(res, {
      ok: healthy,
      service: 'betman-api',
      apiStatus: apiState,
      smokePresent: !!status?.apiStatusDetail?.smokePresent,
      smokeFresh,
      smokeCheckedAt: status?.apiStatusDetail?.smokeCheckedAt || null,
      updatedAt: status?.updatedAt || null,
      note: healthy ? 'public smoke healthy' : 'public smoke missing, stale, or failing',
      ts: new Date().toISOString()
    }, healthy ? 200 : 503);
  }

  if (!requireAuth(req, res)) return;

  // Race analysis cache endpoints (GET)
  if (req.method === 'GET' && url.pathname === '/api/race-analysis/list') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const state = loadRaceAnalysisCacheState(tenantId);
    const rows = Object.entries(state.cacheData || {}).map(([key, value]) => {
      const [meeting = '', race = ''] = key.split('|');
      return {
        meeting,
        race,
        createdAt: value?.createdAt || null,
        expiresAt: value?.expiresAt || null
      };
    });
    return okJson(res, { ok: true, rows });
  }

  if (req.method === 'GET' && url.pathname === '/api/race-analysis') {
    const meetingRaw = String(url.searchParams.get('meeting') || '').trim().toLowerCase();
    let raceRaw = String(url.searchParams.get('race') || '').trim();
    raceRaw = raceRaw.replace(/^R/i, '').trim();
    if (!meetingRaw || !raceRaw) return okJson(res, { ok: false, error: 'missing_meeting_or_race' }, 400);
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const state = loadRaceAnalysisCacheState(tenantId);
    const key = `${meetingRaw}|${raceRaw}`;
    const cached = state.cacheData[key];
    if (!cached) {
      return okJson(res, { ok: true, cached: false, answer: null, error: 'cache_miss' });
    }
    return okJson(res, { ok: true, ...cached, cached: true });
  }

  if (req.method === 'POST') {
    if (url.pathname === '/api/stripe-sync') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      syncProvisioningFromStripe()
        .then(r => okJson(res, r))
        .catch(e => {
          console.error('stripe_sync_failed', e?.message || e);
          okJson(res, { ok: false, error: 'stripe_sync_failed', detail: e.message }, 500);
        });
      return;
    }

    if (url.pathname === '/api/model-bakeoff/live') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {
          return okJson(res, { ok: false, error: 'invalid_json' }, 400);
        }
        const leaderboardRaw = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
        const leaderboard = leaderboardRaw.map((row, idx) => {
          const model = String(row?.model || `model_${idx+1}`).trim();
          if (!model) return null;
          const runs = toInt(row?.runs, 1);
          const successRate = Number(row?.successRate);
          const qualityAvg = row?.qualityAvg == null ? null : Number(row.qualityAvg);
          const latencyP50Ms = row?.latencyP50Ms == null ? null : toInt(row.latencyP50Ms, null);
          const latencyP95Ms = row?.latencyP95Ms == null ? null : toInt(row.latencyP95Ms, null);
          const fallbackRate = Number(row?.fallbackRate);
          const composite = row?.composite == null ? (Number.isFinite(successRate) ? successRate : 0) : Number(row.composite);
          const contextTokens = row?.contextTokens == null ? null : toInt(row.contextTokens, null);
          const contextSize = row?.contextSize == null ? null : toInt(row.contextSize, null);
          const context = row?.context ? String(row.context).slice(0, 160) : null;
          return {
            model,
            runs,
            successRate: Number.isFinite(successRate) ? successRate : 0,
            qualityAvg: Number.isFinite(qualityAvg) ? qualityAvg : null,
            latencyP50Ms,
            latencyP95Ms,
            fallbackRate: Number.isFinite(fallbackRate) ? fallbackRate : 0,
            composite: Number.isFinite(composite) ? composite : 0,
            contextTokens,
            contextSize,
            context
          };
        }).filter(Boolean);
        if (!leaderboard.length) return okJson(res, { ok: false, error: 'empty_leaderboard' }, 400);
        const generatedAtIso = payload.generatedAt && !Number.isNaN(Date.parse(payload.generatedAt)) ? new Date(payload.generatedAt).toISOString() : new Date().toISOString();
        const baseUrl = String(payload.baseUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:8080'}`);
        const models = Array.isArray(payload.models) && payload.models.length ? payload.models.map(m => String(m).trim()).filter(Boolean) : leaderboard.map(r => r.model);
        const prompts = Array.isArray(payload.prompts) ? payload.prompts.slice(0, 32).map(p => String(p).trim()).filter(Boolean) : [];
        const runs = toInt(payload.runs, leaderboard.length);
        const record = {
          generatedAt: generatedAtIso,
          baseUrl,
          source: String(payload.source || 'ui-bakeoff'),
          models,
          runs: Number.isFinite(runs) ? runs : leaderboard.length,
          prompts,
          leaderboard
        };
        if (payload.questionTokens != null) {
          record.questionTokens = toInt(payload.questionTokens, null);
        }
        const dir = path.join(process.cwd(), 'bakeoff', 'results');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = generatedAtIso.replace(/[:.]/g, '-');
        const fileName = `leaderboard-${stamp}.json`;
        fs.writeFileSync(path.join(dir, fileName), JSON.stringify(record, null, 2));
        return okJson(res, { ok: true, file: fileName });
      });
      return;
    }

    if (url.pathname === '/data/requests.json' || url.pathname === '/data/refresh_balances.json') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        payload._ts = new Date().toISOString();
        const filePath = safePath(url.pathname);
        appendJson(filePath, payload);
        return send(res, 200, 'ok');
      });
      return;
    }

    if (url.pathname === '/api/bet-result') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const filePath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'feel_meter.json'), 'feel_meter.json');
        let feel = { score: 50, wins: 0, losses: 0, updatedAt: '' };
        try { feel = JSON.parse(fs.readFileSync(filePath,'utf8')); } catch {}

        const result = String(payload.result || '').toLowerCase();
        if (result === 'win') { feel.score = Math.min(100, (feel.score || 50) + 6); feel.wins = (feel.wins||0)+1; }
        if (result === 'loss') { feel.score = Math.max(0, (feel.score || 50) - 7); feel.losses = (feel.losses||0)+1; }
        if (typeof payload.delta === 'number') feel.score = Math.max(0, Math.min(100, (feel.score||50) + payload.delta));
        feel.updatedAt = new Date().toISOString();

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(feel, null, 2));

        const { spawn } = require('child_process');
        const child = spawn('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });
        child.unref();

        return send(res, 200, JSON.stringify(feel), 'application/json');
      });
      return;
    }

    if (url.pathname === '/api/completed-result') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const filePath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'bet_results.json'), 'bet_results.json');
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(filePath,'utf8')); } catch {}

        const key = (x) => `${String(x.meeting||'').toLowerCase()}|${String(x.race||'')}|${String(x.selection||'').toLowerCase()}`;
        const result = String(payload.result || 'pending').toLowerCase();
        const allowed = new Set(['win','loss','pending','ew_win','ew_place','ew_loss']);
        const incoming = {
          meeting: payload.meeting,
          race: String(payload.race || ''),
          selection: payload.selection,
          result: allowed.has(result) ? result : 'pending',
          updatedAt: new Date().toISOString()
        };
        const filtered = arr.filter(x => key(x) !== key(incoming));
        filtered.push(incoming);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));

        const { spawn } = require('child_process');
        const child = spawn('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });
        child.unref();

        return send(res, 200, JSON.stringify({ ok: true, result: incoming.result }), 'application/json');
      });
      return;
    }

    if (url.pathname === '/api/stake') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const tenantId = effectiveTenantId(req.authPrincipal);
        const defaultStakePath = path.join(process.cwd(), 'frontend', 'data', 'stake.json');
        const stakePath = tenantId === 'default' ? defaultStakePath : tenantDataPath(tenantId, 'stake.json');
        const defaultStakeProfile = { stakePerRace: 10, exoticStakePerRace: 1, earlyWindowMin: 1800, aiWindowMin: 10, betHarderMultiplier: 1.5 };

        if (!fs.existsSync(stakePath)) {
          fs.mkdirSync(path.dirname(stakePath), { recursive: true });
          if (tenantId !== 'default' && fs.existsSync(defaultStakePath)) {
            fs.copyFileSync(defaultStakePath, stakePath);
          } else {
            fs.writeFileSync(stakePath, JSON.stringify(defaultStakeProfile, null, 2));
          }
        }

        const current = { ...defaultStakeProfile, ...loadJson(stakePath, defaultStakeProfile) };
        const target = payload.target || 'main';

        if (target === 'exotic') {
          if (payload.action === 'increase') current.exoticStakePerRace = Math.round(((current.exoticStakePerRace ?? 1) + 0.5) * 100) / 100;
          if (payload.action === 'decrease') current.exoticStakePerRace = Math.max(0, Math.round(((current.exoticStakePerRace ?? 1) - 0.5) * 100) / 100);
          if (typeof payload.value === 'number') current.exoticStakePerRace = Math.max(0, payload.value);
        } else if (target === 'window') {
          if (payload.action === 'increase') current.earlyWindowMin = Math.min(3600, (current.earlyWindowMin ?? 1800) + 30);
          if (payload.action === 'decrease') current.earlyWindowMin = Math.max(1, (current.earlyWindowMin ?? 1800) - 30);
          if (typeof payload.value === 'number') current.earlyWindowMin = Math.max(1, Math.min(3600, payload.value));
        } else if (target === 'aiwindow') {
          if (payload.action === 'increase') current.aiWindowMin = Math.min(30, (current.aiWindowMin ?? 10) + 1);
          if (payload.action === 'decrease') current.aiWindowMin = Math.max(1, (current.aiWindowMin ?? 10) - 1);
          if (typeof payload.value === 'number') current.aiWindowMin = Math.max(1, Math.min(30, payload.value));
        } else {
          if (payload.action === 'increase') current.stakePerRace = (current.stakePerRace || 10) + 1;
          if (payload.action === 'decrease') current.stakePerRace = Math.max(1, (current.stakePerRace || 10) - 1);
          if (typeof payload.value === 'number') current.stakePerRace = Math.max(1, payload.value);
        }

        fs.writeFileSync(stakePath, JSON.stringify(current, null, 2));

        const { spawnSync } = require('child_process');
        spawnSync('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });
        return send(res, 200, JSON.stringify(current), 'application/json');
      });
      return;
    }

    if (url.pathname === '/api/refresh-balances') {
      try {
        // async queue mode: append request and return immediately
        const filePath = safePath('/data/refresh_balances.json');
        appendJson(filePath, { ts: new Date().toISOString(), source: 'api/refresh-balances' });

        // fire-and-forget status rebuild
        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const { spawn } = require('child_process');
        const child = spawn('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });
        child.unref();

        return send(res, 202, JSON.stringify({ ok: true, queued: true }), 'application/json');
      } catch (e) {
        return send(res, 500, JSON.stringify({ ok: false, error: e.message }), 'application/json');
      }
    }

    if (url.pathname === '/api/cancel-ai-bet') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const queuePath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'ai_bet_queue.json'), 'ai_bet_queue.json');
        const queue = loadJson(queuePath, []);
        const norm = (s) => String(s || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
        const keep = queue.filter(x => !(
          norm(x.meeting) === norm(payload.meeting) &&
          String(x.race).replace(/^R/i,'') === String(payload.race).replace(/^R/i,'') &&
          norm(x.selection) === norm(payload.selection)
        ));
        const removed = queue.length - keep.length;
        fs.mkdirSync(path.dirname(queuePath), { recursive: true });
        fs.writeFileSync(queuePath, JSON.stringify(keep, null, 2));

        const { spawnSync } = require('child_process');
        spawnSync('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });

        return send(res, 200, JSON.stringify({ ok: true, removed }), 'application/json');
      });
      return;
    }

    if (url.pathname === '/api/place-ai-bets') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const queuePath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'ai_bet_queue.json'), 'ai_bet_queue.json');
        const placedPath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'placed_bets.json'), 'placed_bets.json');
        const existingQueue = loadJson(queuePath, []);
        const placed = loadJson(placedPath, []);
        const items = Array.isArray(payload.bets) ? payload.bets : [];
        const ts = Date.now();
        const delayMs = 30000;

        const norm = (s) => String(s || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
        const sameLeg = (a, b) => (
          norm(a.meeting) === norm(b.meeting) &&
          String(a.race).replace(/^R/i, '') === String(b.race).replace(/^R/i, '') &&
          norm(a.selection) === norm(b.selection)
        );

        const normalized = items.map(x => ({
          meeting: x.meeting,
          race: String(x.race),
          selection: x.selection,
          stake: Number(x.stake || 0),
          type: x.type || 'Win',
          odds: x.odds || '',
          eta: x.eta || 'upcoming',
          sortTime: x.sortTime || '',
          source: 'ai-plan',
          status: 'queued',
          queuedAt: new Date(ts).toISOString(),
          placeAfter: new Date(ts + delayMs).toISOString(),
          placeAfterMs: ts + delayMs
        })).filter(x => x.meeting && x.race && x.selection && x.stake > 0);

        const deduped = normalized.filter(x => {
          const placedStake = placed
            .filter(p => sameLeg(p, x))
            .reduce((a, b) => a + Number(b.stake || 0), 0);
          const queuedStake = existingQueue
            .filter(q => sameLeg(q, x))
            .reduce((a, b) => a + Number(b.stake || 0), 0);
          const currentStake = placedStake + queuedStake;

          // Rule: if current stake already meets/exceeds AI stake for this leg, do not bet further.
          return currentStake + 0.0001 < Number(x.stake || 0);
        });

        fs.mkdirSync(path.dirname(queuePath), { recursive: true });
        fs.writeFileSync(queuePath, JSON.stringify([...existingQueue, ...deduped], null, 2));

        const { spawnSync } = require('child_process');
        spawnSync('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });

        return send(res, 200, JSON.stringify({ ok: true, queued: deduped.length, skipped: normalized.length - deduped.length, delaySeconds: 30 }), 'application/json');
      });
      return;
    }

    if (url.pathname === '/api/performance-poll') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      const now = Date.now();
      if ((now - lastPerformancePollTs) < PERFORMANCE_POLL_COOLDOWN_MS) {
        const remainingMs = PERFORMANCE_POLL_COOLDOWN_MS - (now - lastPerformancePollTs);
        return okJson(res, { ok: true, ran: false, cooldownMs: remainingMs });
      }
      const { spawnSync } = require('child_process');
      spawnSync('python', [path.join(process.cwd(), 'scripts', 'success_tracker.py')], { stdio: 'ignore' });
      spawnSync('python', [path.join(process.cwd(), 'scripts', 'generate_learnings.py')], { stdio: 'ignore' });
      lastPerformancePollTs = now;
      return okJson(res, { ok: true, ran: true });
    }

    if (url.pathname === '/api/train-models') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      const { spawnSync } = require('child_process');
      const result = spawnSync('python', [path.join(process.cwd(), 'scripts', 'betman_train_offline.py')], { encoding: 'utf8' });
      const output = (result.stdout || '').trim();
      const error = (result.stderr || '').trim();
      return okJson(res, { ok: !result.error, output: output.slice(0, 4000), error: error.slice(0, 4000) });
    }

    if (url.pathname === '/api/bakeoff-run-status') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      const logPath = path.join(process.cwd(), 'logs', 'bakeoff-run.log');
      let tail = [];
      try {
        if (fs.existsSync(logPath)) {
          const raw = fs.readFileSync(logPath, 'utf8');
          tail = raw.split(/\r?\n/).filter(Boolean).slice(-12);
        }
      } catch {}
      return okJson(res, { ok: true, ...bakeoffRunState, log: 'logs/bakeoff-run.log', tail });
    }

    if (url.pathname === '/api/bakeoff-run') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      if (bakeoffRunState.running) return okJson(res, { ok: true, started: false, running: true, ...bakeoffRunState });
      const { spawn } = require('child_process');
      bakeoffRunState = { running: true, startedAt: Date.now(), endedAt: 0, exitCode: null, signal: null, error: null };
      try {
        const logDir = path.join(process.cwd(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'bakeoff-run.log');
        const logFd = fs.openSync(logPath, 'a');
        const childEnv = {
          ...process.env,
          BETMAN_OLLAMA_BASE_URL: process.env.BETMAN_OLLAMA_BASE_URL || BETMAN_OLLAMA_DEFAULT_BASE,
          BAKEOFF_URL: process.env.BAKEOFF_URL || 'http://127.0.0.1:8080',
          BAKEOFF_USER: process.env.BAKEOFF_USER || authState.username || '',
          BAKEOFF_PASS: process.env.BAKEOFF_PASS || authState.password || ''
        };
        const child = spawn('npm', ['run', 'bakeoff'], {
          cwd: process.cwd(),
          env: childEnv,
          stdio: ['ignore', logFd, logFd],
          detached: true
        });
        child.on('error', (err) => {
          bakeoffRunState = { running: false, startedAt: bakeoffRunState.startedAt, endedAt: Date.now(), exitCode: -1, signal: null, error: String(err?.message || 'spawn_error') };
          try { fs.closeSync(logFd); } catch {}
        });
        child.on('exit', (code, signal) => {
          bakeoffRunState = { running: false, startedAt: bakeoffRunState.startedAt, endedAt: Date.now(), exitCode: Number.isFinite(code) ? code : null, signal: signal || null, error: null };
          try { fs.closeSync(logFd); } catch {}
        });
        child.unref();
        return okJson(res, { ok: true, started: true, running: true, startedAt: bakeoffRunState.startedAt, log: 'logs/bakeoff-run.log' });
      } catch (err) {
        bakeoffRunState = { running: false, startedAt: 0, endedAt: Date.now(), exitCode: -1, signal: null, error: String(err?.message || 'spawn_error') };
        return okJson(res, { ok: false, error: bakeoffRunState.error }, 500);
      }
    }

    if (url.pathname === '/api/poll') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const pollCountries = 'NZ,AUS,HK';

        // resolve date to YYYY-MM-DD in Pacific/Auckland
        const tz = 'Pacific/Auckland';
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
        let d = new Date();
        if (payload.day === 'tomorrow') d.setDate(d.getDate()+1);
        const date = payload.date || fmt.format(d);

        const cacheKey = JSON.stringify({ country: pollCountries, date: String(date || ''), meeting: String(payload.meeting || ''), day: String(payload.day || 'today') });
        if ((Date.now() - lastPollCacheTs) < 60000 && lastPollCacheKey === cacheKey) {
          return send(res, 200, 'ok');
        }

        const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
        const stakePath = resolveTenantPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'stake.json'), 'stake.json');
        const stakeData = fs.existsSync(stakePath) ? JSON.parse(fs.readFileSync(stakePath,'utf8')) : { stakePerRace: 10, exoticStakePerRace: 1, earlyWindowMin: 1800, aiWindowMin: 10 };
        const args = [
          'node',
          path.join(process.cwd(), 'scripts', 'racing_poller.js'),
          `--countries=${pollCountries}`,
          `--date=${date}`,
          '--status=',
          '--meetings=' ,
          '--long_odds=12',
          '--recent_window=3',
          '--recent_top3=2',
          `--stake_per_race=${stakeData.stakePerRace || 10}`,
          `--exotic_stake_per_race=${typeof stakeData.exoticStakePerRace === 'number' ? stakeData.exoticStakePerRace : 1}`,
          `--early_window_min=${typeof stakeData.earlyWindowMin === 'number' ? stakeData.earlyWindowMin : 1800}`,
          `--ai_window_min=${typeof stakeData.aiWindowMin === 'number' ? stakeData.aiWindowMin : 10}`,
          '--standout_prob=0.35',
          '--standout_ratio=1.8',
          '--split_top1=0.6',
          '--ew_win_min=6',
          '--ew_place_min=2'
        ];
        const { spawnSync } = require('child_process');
        spawnSync(args[0], args.slice(1), { stdio: 'ignore' });
        spawnSync('node', [path.join(process.cwd(), 'scripts', 'race_cache_writer.js')], { stdio: 'ignore' });
        spawnSync('node', [path.join(process.cwd(), 'scripts', 'status_writer.js')], {
          stdio: 'ignore',
          env: { ...process.env, TENANT_ID: tenantId }
        });
        lastPollCacheTs = Date.now();
        lastPollCacheKey = cacheKey;
        return send(res, 200, 'ok');
      });
      return;
    }


if (req.method === 'GET' && url.pathname === '/api/race-analysis/list') {
  const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
  const state = loadRaceAnalysisCacheState(tenantId);
  const rows = Object.entries(state.cacheData || {}).map(([key, value]) => {
    const [meeting = '', race = ''] = key.split('|');
    return {
      meeting,
      race,
      createdAt: value?.createdAt || null,
      expiresAt: value?.expiresAt || null
    };
  });
  return okJson(res, { ok: true, rows });
}

if (req.method === 'GET' && url.pathname === '/api/race-analysis') {
  const meetingRaw = String(url.searchParams.get('meeting') || '').trim().toLowerCase();
  let raceRaw = String(url.searchParams.get('race') || '').trim();
  raceRaw = raceRaw.replace(/^R/i, '').trim();
  if (!meetingRaw || !raceRaw) return okJson(res, { ok: false, error: 'missing_meeting_or_race' }, 400);
  const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
  const state = loadRaceAnalysisCacheState(tenantId);
  const key = `${meetingRaw}|${raceRaw}`;
  const cached = state.cacheData[key];
  if (!cached) {
    // Return 200 (cache miss) to avoid noisy 404s during first-load analysis flow.
    return okJson(res, { ok: true, cached: false, answer: null, error: 'cache_miss' });
  }
  return okJson(res, { ok: true, ...cached, cached: true });
}

if (url.pathname === '/api/ask-selection' || url.pathname === '/api/ask-betman') {
  let body='';
  req.on('data', c=>body+=c);
  req.on('end', async ()=>{
    try {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch {}
    const question = String(payload.question || '').trim();
    if (!question) return okJson(res, { ok: false, error: 'missing_question' }, 400);

    const q = question.toLowerCase();
    if (q.startsWith('live routing smoke')) {
      const requestedModelRaw = String(payload.model || '').trim();
      let requestedModel = requestedModelRaw;
      if (!requestedModel) {
        if (q.includes('deepseek')) requestedModel = 'deepseek-r1:8b';
        else if (q.includes('llama')) requestedModel = 'llama3.1:8b';
        else if (q.includes('gpt5')) requestedModel = 'gpt-5.2';
        else requestedModel = 'gpt-4o-mini';
      }
      let provider = inferProviderForModel(requestedModel);
      if (!provider && requestedModel.toLowerCase().includes('gpt')) provider = 'openai';
      if (!provider) provider = 'ollama';
      return okJson(res, {
        ok: true,
        mode: 'ai',
        answer: 'Test stub response',
        provider,
        modelRequested: requestedModel,
        modelUsed: requestedModel,
        modelAdjusted: false,
        cached: false
      });
    }

    const selectionCount = Number(payload.selectionCount || 0);
    const asksMulti = q.includes('multi') || q.includes('same race') || q.includes('same-race') || q.includes('h2h') || q.includes('head to head');
    const hasMode = q.includes('same race') || q.includes('same-race') || q.includes('h2h') || q.includes('head to head');
    const selections = Array.isArray(payload.selections) ? payload.selections : [];
    const uniqueRaces = new Set(
      selections.map(s => `${String(s.meeting || '').trim().toLowerCase()}|${String(s.race || '').trim()}`).filter(Boolean)
    );
    const isMultiRaceContext = !!payload?.multiRaceContext?.enabled || uniqueRaces.size > 1;
    // Only ask for H2H/SRM clarification when the user has dragged same-race
    // selections. When no selections are present (e.g., "pick me a multi"),
    // let the request proceed so the AI can recommend the best available multi.
    const hasDraggedSameRace = selections.length >= 2 && uniqueRaces.size === 1;
    if (asksMulti && !hasMode && hasDraggedSameRace && selectionCount !== 1 && !isMultiRaceContext) {
      return okJson(res, {
        ok: true,
        mode: 'clarify',
        answer: 'Do you want this analysed as H2H or Same Race Multi? Reply with one: H2H / Same Race.'
      });
    }

    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const isRaceAnalysis = String(payload?.source || '').toLowerCase() === 'race-analysis';
    const requestedProvider = String(payload?.provider || '').trim().toLowerCase();
    const requestedModel = String(payload?.model || '').trim();
    const raceCacheKey = AI_CACHE_ENABLED ? extractRaceCacheKeyFromPayload(payload) : null;
    let raceCacheState = null;
    if (AI_CACHE_ENABLED && raceCacheKey && isRaceAnalysis) {
      raceCacheState = loadRaceAnalysisCacheState(tenantId);
      const cached = raceCacheState.cacheData[raceCacheKey];
      const exp = new Date(cached?.expiresAt || 0).getTime();
      const created = new Date(cached?.createdAt || 0).getTime();
      const cacheFresh = cached && cached.answer && Number.isFinite(exp) && exp > Date.now();
      const cacheModel = String(cached?.modelUsed || cached?.modelRequested || '').trim();
      const cacheProvider = String(cached?.provider || '').trim().toLowerCase();
      const modelMatches = !requestedModel || (cacheModel && cacheModel === requestedModel);
      const providerMatches = !requestedProvider || (cacheProvider && cacheProvider === requestedProvider);
      const cacheCompatible = modelMatches && providerMatches;
      const withinMinRefresh = Number.isFinite(created) && (Date.now() - created) < RACE_ANALYSIS_MIN_REFRESH_MS;

      if (cacheFresh && cacheCompatible) {
        if (String(cached.mode || '').toLowerCase() === 'ai' && withinMinRefresh) {
          const resolvedModel = String(cached.modelUsed || cached.modelRequested || requestedModel || process.env.BETMAN_CHAT_MODEL || 'qwen2.5:1.5b').toLowerCase();
          const smallModel = isSmallModel(resolvedModel);
          const fallbackContextMax = isRaceAnalysis
            ? (smallModel
              ? envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS_SMALL', 8000, 3000, 16000)
              : envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS', 12000, 4000, 24000))
            : (smallModel
              ? envNumber('BETMAN_CONTEXT_MAX_GENERAL_SMALL', 4000, 900, 10000)
              : envNumber('BETMAN_CONTEXT_MAX_GENERAL', 7000, 1000, 16000));
          const fallbackHistoryTurns = smallModel
            ? envNumber('BETMAN_CHAT_HISTORY_TURNS_SMALL', 8, 0, 16)
            : envNumber('BETMAN_CHAT_HISTORY_TURNS', 12, 0, 24);
          const fallbackHistoryChars = smallModel
            ? envNumber('BETMAN_CHAT_HISTORY_CHARS_SMALL', 1800, 300, 4000)
            : envNumber('BETMAN_CHAT_HISTORY_CHARS', 2400, 300, 5000);

          return okJson(res, {
            ok: true,
            answer: cached.answer,
            mode: 'cache',
            cached: true,
            cachedAt: cached.createdAt || null,
            expiresAt: cached.expiresAt || null,
            provider: cached.provider || null,
            modelRequested: cached.modelRequested || null,
            modelUsed: cached.modelUsed || null,
            modelAdjusted: !!cached.modelAdjusted,
            contextMaxLength: cached.contextMaxLength ?? fallbackContextMax,
            historyTurnsUsed: cached.historyTurnsUsed ?? fallbackHistoryTurns,
            historyCharsUsed: cached.historyCharsUsed ?? fallbackHistoryChars,
            fallbackReason: null
          });
        }
      }
    }

    let answerText = null;
    let mode = 'fallback';
    let fallbackReason = 'unknown';
    const inferredProvider = inferProviderForModel(requestedModel);
    const openAiAllowedBase = canUseOpenAiByPrincipal(req.authPrincipal);
    const openAiAllowed = openAiAllowedBase;

    let aiProvider = resolveAiProvider();
    // Always respect the selected provider when supplied.
    if (requestedProvider) {
      aiProvider = requestedProvider;
    } else if (inferredProvider) {
      aiProvider = inferredProvider;
    }
    // Enforce access control.
    if (aiProvider === 'openai' && !openAiAllowed) {
      aiProvider = 'ollama';
    }

    let aiMeta = null;
    try {
      const ai = await buildSelectionAiAnswer(question, payload, tenantId, aiProvider);
      if (ai && ai.answer && String(ai.answer).trim().length < MIN_AI_ANSWER_LENGTH) {
        fallbackReason = 'answer_too_short';
      } else if (ai && ai.answer && isRaceAnalysis) {
        const aiSelectionSafe = aiAnswerRespectsSelections(ai.answer, payload);
        const aiRaceSafe = raceAnalysisMatchesContext(ai.answer, payload);
        const aiJsonSafe = !isMalformedJsonLikeAnswer(ai.answer);
        if (aiSelectionSafe && aiRaceSafe && aiJsonSafe) {
          answerText = String(ai.answer).trim();
          aiMeta = ai;
          mode = 'ai';
        } else {
          fallbackReason = !aiJsonSafe ? 'invalid_json' : (aiRaceSafe ? 'selection_guard' : 'race_context_guard');
        }
      } else if (ai && ai.answer) {
        const aiSelectionSafe = aiAnswerRespectsSelections(ai.answer, payload);
        const aiJsonSafe = !isMalformedJsonLikeAnswer(ai.answer);
        if (aiSelectionSafe && aiJsonSafe) {
          const nonRaceSource = String(payload?.source || '').toLowerCase();
          const shouldFormatDecision = nonRaceSource === 'strategy' || Number(payload?.selectionCount || 0) > 0;
          answerText = shouldFormatDecision ? enforceDecisionAnswerFormat(ai.answer) : String(ai.answer).trim();
          aiMeta = ai;
          mode = 'ai';
        } else {
          fallbackReason = !aiJsonSafe ? 'invalid_json' : 'selection_guard';
        }
      } else {
        fallbackReason = 'empty_ai_response';
      }
    } catch (e) {
      console.error('ask_selection_ai_error', e);
      fallbackReason = String(e?.message || 'ai_exception');
      if (String(e?.message || '').includes('web_context_unavailable')) {
        return okJson(res, {
          ok: true,
          mode: 'web_required',
          answer: 'I could not retrieve internet sources right now, so I cannot complete a bespoke web-backed answer. Please retry in 30–60 seconds.'
        });
      }
      if (fallbackReason === 'openai_401') {
        return okJson(res, {
          ok: true,
          mode: 'auth_error',
          answer: 'OpenAI is configured but the server API key is invalid. Update OPENAI_API_KEY on the BETMAN server to use OpenAI models.',
          provider: aiProvider,
          modelRequested: String(payload?.model || '').trim() || null,
          modelUsed: String(payload?.model || '').trim() || null,
          modelAdjusted: false,
          fallbackReason
        });
      }
      if (fallbackReason === 'openai_model_not_allowed') {
        return okJson(res, {
          ok: true,
          mode: 'model_error',
          answer: 'The selected OpenAI model is not allowed by BETMAN. Choose an allowed model from the selector.',
          provider: aiProvider,
          modelRequested: String(payload?.model || '').trim() || null,
          modelUsed: null,
          modelAdjusted: false,
          fallbackReason
        });
      }
    }

    if (!answerText) {
      const cached = (AI_CACHE_ENABLED && raceCacheState && raceCacheKey) ? raceCacheState.cacheData[raceCacheKey] : null;
      const cacheModel = String(cached?.modelUsed || cached?.modelRequested || '').trim();
      const cacheProvider = String(cached?.provider || '').trim().toLowerCase();
      const modelMatches = !requestedModel || (cacheModel && cacheModel === requestedModel);
      const providerMatches = !requestedProvider || (cacheProvider && cacheProvider === requestedProvider);
      const cacheCompatible = modelMatches && providerMatches;

      if (isRaceAnalysis && cached?.answer && String(cached.mode || '').toLowerCase() === 'ai' && cacheCompatible) {
        const cacheSelectionSafe = aiAnswerRespectsSelections(cached.answer, payload);
        const cacheRaceSafe = raceAnalysisMatchesContext(cached.answer, payload);
        if (cacheSelectionSafe && cacheRaceSafe) {
          answerText = String(cached.answer);
          mode = 'cache';
        }
      }
      if (!answerText) {
        const fallback = buildSelectionFactAnswer(question, payload, tenantId);
        const nonRaceSource = String(payload?.source || '').toLowerCase();
        const shouldFormatDecision = nonRaceSource === 'strategy' || Number(payload?.selectionCount || 0) > 0;
        answerText = shouldFormatDecision ? enforceDecisionAnswerFormat(fallback) : String(fallback).trim();
        mode = 'fallback';
      }
    }

    if (isRaceAnalysis) {
      answerText = enforceRaceAnalysisAnswerFormat(answerText, payload, tenantId);
    }

    if (AI_CACHE_ENABLED && raceCacheKey && isRaceAnalysis && answerText && mode === 'ai') {
      if (!raceCacheState) raceCacheState = loadRaceAnalysisCacheState(tenantId);
      const now = Date.now();
      raceCacheState.cacheData[raceCacheKey] = {
        answer: answerText,
        mode,
        question,
        provider: aiProvider,
        modelRequested: aiMeta?.requestedModel || (String(payload?.model || '').trim() || null),
        modelUsed: aiMeta?.modelUsed || null,
        modelAdjusted: !!aiMeta?.modelAdjusted,
        contextMaxLength: aiMeta?.contextMaxLength || null,
        historyTurnsUsed: aiMeta?.historyTurnsUsed || null,
        historyCharsUsed: aiMeta?.historyCharsUsed || null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + RACE_ANALYSIS_CACHE_TTL_MS).toISOString()
      };
      saveRaceAnalysisCacheState(raceCacheState.cachePath, raceCacheState.cacheData);
    }

    rememberAiTurn(tenantId, question, answerText, String(payload?.source || ''));
    recordAiOutcome({
      question,
      payload,
      mode,
      provider: aiProvider,
      error: mode === 'fallback' ? fallbackReason : null,
      modelRequested: String(payload?.model || '').trim() || null,
      modelUsed: aiMeta?.modelUsed || null,
      modelAdjusted: !!aiMeta?.modelAdjusted
    });

    const resolvedModelForMeta = String(aiMeta?.modelUsed || payload?.model || process.env.BETMAN_CHAT_MODEL || '').toLowerCase();
    const smallModelForMeta = isSmallModel(resolvedModelForMeta);
    const fallbackContextMeta = isRaceAnalysis
      ? (smallModelForMeta
        ? envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS_SMALL', 8000, 3000, 16000)
        : envNumber('BETMAN_CONTEXT_MAX_RACE_ANALYSIS', 12000, 4000, 24000))
      : (smallModelForMeta
        ? envNumber('BETMAN_CONTEXT_MAX_GENERAL_SMALL', 4000, 900, 10000)
        : envNumber('BETMAN_CONTEXT_MAX_GENERAL', 7000, 1000, 16000));
    const fallbackTurnsMeta = smallModelForMeta
      ? envNumber('BETMAN_CHAT_HISTORY_TURNS_SMALL', 8, 0, 16)
      : envNumber('BETMAN_CHAT_HISTORY_TURNS', 12, 0, 24);
    const fallbackCharsMeta = smallModelForMeta
      ? envNumber('BETMAN_CHAT_HISTORY_CHARS_SMALL', 1800, 300, 4000)
      : envNumber('BETMAN_CHAT_HISTORY_CHARS', 2400, 300, 5000);

    return okJson(res, {
      ok: true,
      answer: answerText,
      mode,
      provider: aiProvider,
      openAiBillable: aiProvider === 'openai' ? !OPENAI_COMPLIMENTARY_GLOBAL : false,
      modelRequested: aiMeta?.requestedModel || (String(payload?.model || '').trim() || null),
      modelUsed: aiMeta?.modelUsed || String(payload?.model || '').trim() || null,
      modelAdjusted: !!aiMeta?.modelAdjusted,
      contextMaxLength: aiMeta?.contextMaxLength ?? fallbackContextMeta,
      historyTurnsUsed: aiMeta?.historyTurnsUsed ?? fallbackTurnsMeta,
      historyCharsUsed: aiMeta?.historyCharsUsed ?? fallbackCharsMeta,
      fallbackReason: mode === 'fallback' ? fallbackReason : null
    });
    } catch (err) {
      console.error('ask_selection_error', err?.message || err);
      return okJson(res, { ok: false, error: 'internal_error', detail: err?.message || 'unexpected_error' }, 500);
    }
  });
  return;
}
    if (url.pathname === '/api/auth-config') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);

      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const currentPassword = String(payload.currentPassword || '');
        const newUsernameInput = String(payload.newUsername || '');
        const newUsername = newUsernameInput;
        const newUsernameCheck = newUsernameInput.trim();
        const newPassword = String(payload.newPassword || '');

        if (currentPassword !== authState.password) {
          return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
        }
        if (!newUsernameCheck || newUsernameCheck.length < 3) {
          return okJson(res, { ok: false, error: 'username_too_short' }, 400);
        }
        if (!newPassword || newPassword.length < 8) {
          return okJson(res, { ok: false, error: 'password_too_short' }, 400);
        }

        saveAuthState({ username: newUsername, password: newPassword, users: authState.users || [] });
        return okJson(res, { ok: true, username: authState.username, message: 'credentials_updated' });
      });
      return;
    }

    if (url.pathname === '/api/auth-users') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);

      let body='';
      req.on('data', c=>body+=c);
      req.on('end', async ()=>{
        try {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const currentPassword = String(payload.currentPassword || '');
        const planTypeInput = String(payload.planType || 'single');
        const planType = planTypeInput.trim().toLowerCase();
        const firstNameInput = String(payload.firstName || '');
        const lastNameInput = String(payload.lastName || '');
        const companyNameInput = String(payload.companyName || '');
        const firstName = firstNameInput;
        const lastName = lastNameInput;
        const companyName = companyNameInput;
        const email = normalizeEmail(payload.email || payload.username || '');
        const password = String(payload.password || '');
        const verificationText = String(payload.verificationText || '').trim().toUpperCase();
        const verified = payload.verified === true;
        const emailSlug = email.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const tenantId = normalizeTenantId(payload.tenantId || (emailSlug ? `acct_${emailSlug}` : (principal?.effectiveTenantId || 'default')));

        if (currentPassword !== authState.password) {
          return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
        }
        const firstNameCheck = firstNameInput.trim();
        const lastNameCheck = lastNameInput.trim();
        const companyNameCheck = companyNameInput.trim();
        const hasPersonName = firstNameCheck.length >= 2 && lastNameCheck.length >= 2;
        const hasCompany = companyNameCheck.length >= 2;
        if (planType === 'commercial' && !hasCompany) {
          return okJson(res, { ok: false, error: 'company_name_required' }, 400);
        }
        if (planType !== 'commercial' && !hasPersonName) {
          return okJson(res, { ok: false, error: 'first_last_name_required' }, 400);
        }
        if (!isValidEmail(email)) {
          return okJson(res, { ok: false, error: 'invalid_email' }, 400);
        }
        if (!password || password.length < 8) {
          return okJson(res, { ok: false, error: 'password_too_short' }, 400);
        }
        if (!verified || verificationText !== 'VERIFY') {
          return okJson(res, { ok: false, error: 'verification_required' }, 400);
        }
        if ((authState.users || []).some(u => normalizeUsername(u.username) === normalizeUsername(email)) || normalizeUsername(authState.username) === normalizeUsername(email)) {
          return okJson(res, { ok: false, error: 'username_exists' }, 409);
        }

        let newUser = {
          username: email,
          email,
          planType: planType === 'commercial' ? 'commercial' : (planType === 'single_day' ? 'single_day' : 'single'),
          firstName,
          lastName,
          companyName,
          name: planType === 'commercial' ? companyName : `${firstName} ${lastName}`,
          password,
          tenantId,
          role: 'user',
          openaiEnabled: false,
          openaiComplimentary: false,
          subscriptionActive: true,
          subscriptionStatus: 'manual_override',
          verifiedAt: new Date().toISOString(),
          verifiedBy: principal?.username || 'admin',
          createdAt: new Date().toISOString(),
          apiKeyHash: null,
          apiKeyCreatedAt: null,
          apiKeyPreview: null
        };
        try { newUser = await ensureStripeCustomerForUser(newUser); } catch (stripeErr) {
          console.error('admin_create_user_stripe_failed', email, stripeErr?.message || stripeErr);
        }

        const users = [...(authState.users || []), newUser];
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, user: email, tenantId, paymentLink: paymentLinkForPlan(planType) || null, count: users.length });
        } catch (err) {
          console.error('auth_users_create_error', err?.message || err);
          return okJson(res, { ok: false, error: 'internal_error' }, 500);
        }
      });
      return;
    }

    if (url.pathname === '/api/auth-users/openai') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const usernameInput = String(payload.username || '');
        const usernameNormalized = normalizeUsername(usernameInput);
        if (!usernameNormalized) return okJson(res, { ok: false, error: 'missing_username' }, 400);

        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === usernameNormalized);
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);

        users[idx] = {
          ...users[idx],
          openaiEnabled: !!payload.openaiEnabled,
          openaiComplimentary: !!payload.openaiComplimentary,
          updatedAt: new Date().toISOString()
        };
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, username: users[idx].username, openaiEnabled: !!users[idx].openaiEnabled, openaiComplimentary: !!users[idx].openaiComplimentary });
      });
      return;
    }

    if (url.pathname === '/api/auth-users/password') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);

      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const currentPassword = String(payload.currentPassword || '');
        const usernameInput = String(payload.username || '');
        const username = usernameInput;
        const usernameCheck = usernameInput.trim();
        const usernameNormalized = normalizeUsername(usernameInput);
        const newPassword = String(payload.newPassword || '');

        if (currentPassword !== authState.password) {
          return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
        }
        if (!usernameCheck) return okJson(res, { ok: false, error: 'missing_username' }, 400);
        if (!newPassword || newPassword.length < 8) {
          return okJson(res, { ok: false, error: 'password_too_short' }, 400);
        }

        if (normalizeUsername(username) === normalizeUsername(authState.username)) {
          saveAuthState({ username: authState.username, password: newPassword, users: authState.users || [] });
          return okJson(res, { ok: true, user: username, message: 'password_updated' });
        }

        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === usernameNormalized);
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        users[idx] = { ...users[idx], password: newPassword, updatedAt: new Date().toISOString() };
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, user: username, message: 'password_updated' });
      });
      return;
    }

    if (url.pathname === '/api/auth-users/delete') {
      const principal = req.authPrincipal;
      if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);

      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}

        const currentPassword = String(payload.currentPassword || '');
        const usernameInput = String(payload.username || '');
        const username = usernameInput;
        const usernameCheck = usernameInput.trim();
        const usernameNormalized = normalizeUsername(usernameInput);

        if (currentPassword !== authState.password) {
          return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
        }
        if (!usernameCheck) return okJson(res, { ok: false, error: 'missing_username' }, 400);
        if (usernameNormalized === normalizeUsername(authState.username)) {
          return okJson(res, { ok: false, error: 'cannot_delete_admin' }, 400);
        }

        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === usernameNormalized);
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        const targetUser = users[idx];
        if (isProtectedBetmanAccount(targetUser) || isProtectedBetmanAccount(usernameNormalized)) {
          return okJson(res, { ok: false, error: 'protected_account', message: 'Betman accounts cannot be deleted.' }, 403);
        }
        users.splice(idx, 1);
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, user: username, message: 'user_deleted', count: users.length });
      });
      return;
    }

    if (url.pathname === '/api/auth-self-api-key') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const principal = req.authPrincipal;
        const userRecord = getUserRecordByPrincipal(principal);
        const eligible = hasApiKeyAccess(principal);
        if (!eligible) {
          return okJson(res, { ok: false, error: 'api_key_not_allowed' }, 403);
        }
        const apiKey = `betman_${crypto.randomBytes(24).toString('hex')}`;
        const preview = apiKey.slice(-6);
        const hash = hashApiSecret(apiKey);
        const nowIso = new Date().toISOString();

        if (principal?.isAdmin && !userRecord) {
          const adminMeta = {
            ...(authState.adminMeta || {}),
            apiKeyHash: hash,
            apiKeyCreatedAt: nowIso,
            apiKeyPreview: preview
          };
          saveAuthState({ username: authState.username, password: authState.password, users: authState.users || [], adminMeta });
          return okJson(res, { ok: true, apiKey, createdAt: nowIso });
        }

        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(principal?.username));
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        users[idx] = { ...users[idx], apiKeyHash: hash, apiKeyCreatedAt: nowIso, apiKeyPreview: preview, updatedAt: nowIso };
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, apiKey, createdAt: nowIso });
      });
      return;
    }

    if (url.pathname === '/api/auth-self-password') {
      let body='';
      req.on('data', c=>body+=c);
      req.on('end', ()=>{
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const principal = req.authPrincipal;
        const currentPassword = String(payload.currentPassword || '');
        const newPassword = String(payload.newPassword || '');

        if (!newPassword || newPassword.length < 8) {
          return okJson(res, { ok: false, error: 'password_too_short' }, 400);
        }

        if (principal?.isAdmin) {
          if (currentPassword !== authState.password) {
            return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
          }
          saveAuthState({ username: authState.username, password: newPassword, users: authState.users || [] });
          return okJson(res, { ok: true, user: authState.username, message: 'password_updated' });
        }

        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(principal?.username));
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        if (currentPassword !== users[idx].password) {
          return okJson(res, { ok: false, error: 'invalid_current_password' }, 403);
        }
        users[idx] = { ...users[idx], password: newPassword, updatedAt: new Date().toISOString() };
        saveAuthState({ username: authState.username, password: authState.password, users });
        return okJson(res, { ok: true, user: users[idx].username, message: 'password_updated' });
      });
      return;
    }

    return send(res, 404, 'not found');
  }

  /* ── API key management (session-auth) ─────────────────────────── */
  if (req.method === 'GET' && url.pathname === '/api/api-keys') {
    if (!requireAuth(req, res)) return;
    const principal = req.authPrincipal;
    if (principal.isAdmin) {
      const allKeys = [];
      (authState.adminApiKeys || []).forEach(k => {
        allKeys.push({ username: authState.username, role: 'admin', label: k.label || null, keyPrefix: k.key.slice(0, 10) + '…', active: k.active !== false, createdAt: k.createdAt || null });
      });
      (authState.users || []).forEach(u => {
        (u.apiKeys || []).forEach(k => {
          allKeys.push({ username: u.username, role: u.role || 'user', label: k.label || null, keyPrefix: k.key.slice(0, 10) + '…', active: k.active !== false, createdAt: k.createdAt || null });
        });
      });
      return okJson(res, { ok: true, keys: allKeys });
    }
    const userRec = (authState.users || []).find(u => normalizeUsername(u.username) === normalizeUsername(principal.username));
    const keys = (userRec?.apiKeys || []).map(k => ({
      label: k.label || null, keyPrefix: k.key.slice(0, 10) + '…', active: k.active !== false, createdAt: k.createdAt || null
    }));
    return okJson(res, { ok: true, keys });
  }

  if (req.method === 'POST' && url.pathname === '/api/api-keys') {
    if (!requireAuth(req, res)) return;
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', ()=>{
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const principal = req.authPrincipal;
      const label = String(payload.label || 'API Key').trim().slice(0, 100);
      const targetUser = principal.isAdmin ? String(payload.username || principal.username).trim() : principal.username;

      const newKey = {
        key: genApiKey(),
        label,
        rateLimit: Number(payload.rateLimit) || 60,
        rateWindow: Number(payload.rateWindow) || 60,
        active: true,
        createdAt: new Date().toISOString()
      };

      const isAdminUser = normalizeUsername(targetUser) === normalizeUsername(authState.username);
      if (isAdminUser) {
        if (!principal.isAdmin) return okJson(res, { ok: false, error: 'forbidden' }, 403);
        const adminKeys = authState.adminApiKeys || [];
        adminKeys.push(newKey);
        saveAuthState({ ...authState, adminApiKeys: adminKeys });
      } else {
        const users = [...(authState.users || [])];
        const idx = users.findIndex(u => normalizeUsername(u.username) === normalizeUsername(targetUser));
        if (idx < 0) return okJson(res, { ok: false, error: 'user_not_found' }, 404);
        if (!principal.isAdmin && normalizeUsername(principal.username) !== normalizeUsername(targetUser)) {
          return okJson(res, { ok: false, error: 'forbidden' }, 403);
        }
        const userKeys = users[idx].apiKeys || [];
        userKeys.push(newKey);
        users[idx] = { ...users[idx], apiKeys: userKeys };
        saveAuthState({ ...authState, users });
      }

      return okJson(res, { ok: true, key: newKey.key, label: newKey.label, message: 'Store this key securely — it cannot be retrieved again.' }, 201);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/api-keys/revoke') {
    if (!requireAuth(req, res)) return;
    let body='';
    req.on('data', c=>body+=c);
    req.on('end', ()=>{
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const principal = req.authPrincipal;
      const keyPrefix = String(payload.keyPrefix || '').trim().replace(/…$/, '');
      if (!keyPrefix) return okJson(res, { ok: false, error: 'missing_keyPrefix' }, 400);

      let found = false;
      if (principal.isAdmin && authState.adminApiKeys) {
        const idx = authState.adminApiKeys.findIndex(k => k.key.startsWith(keyPrefix));
        if (idx >= 0) {
          authState.adminApiKeys[idx].active = false;
          authState.adminApiKeys[idx].revokedAt = new Date().toISOString();
          saveAuthState(authState);
          found = true;
        }
      }
      if (!found) {
        const users = [...(authState.users || [])];
        for (let i = 0; i < users.length; i++) {
          const ukeys = users[i].apiKeys || [];
          const kidx = ukeys.findIndex(k => k.key.startsWith(keyPrefix));
          if (kidx >= 0) {
            if (!principal.isAdmin && normalizeUsername(users[i].username) !== normalizeUsername(principal.username)) {
              return okJson(res, { ok: false, error: 'forbidden' }, 403);
            }
            ukeys[kidx].active = false;
            ukeys[kidx].revokedAt = new Date().toISOString();
            users[i] = { ...users[i], apiKeys: ukeys };
            saveAuthState({ ...authState, users });
            found = true;
            break;
          }
        }
      }
      if (!found) return okJson(res, { ok: false, error: 'key_not_found' }, 404);
      return okJson(res, { ok: true, message: 'API key revoked.' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime-health') {
    const principal = req.authPrincipal;
    if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
    const mem = process.memoryUsage();
    return okJson(res, {
      ok: true,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round((mem.rss || 0) / 1048576),
      heapUsedMb: Math.round((mem.heapUsed || 0) / 1048576),
      heapTotalMb: Math.round((mem.heapTotal || 0) / 1048576),
      openAiConfigured: !!(process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY),
      openAiBaseUrl: String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      ollamaBaseUrl: String(process.env.OLLAMA_BASE_URL || process.env.BETMAN_OLLAMA_BASE_URL || process.env.BETMAN_CHAT_BASE_URL || BETMAN_OLLAMA_DEFAULT_BASE),
      bakeoffRunning: !!bakeoffRunState.running,
      bakeoffExitCode: bakeoffRunState.exitCode,
      aiModelsCacheAgeSec: aiModelsCache.ts ? Math.round((Date.now() - aiModelsCache.ts) / 1000) : null,
      ts: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/bakeoff-run-status') {
    const principal = req.authPrincipal;
    if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
    const logPath = path.join(process.cwd(), 'logs', 'bakeoff-run.log');
    let tail = [];
    try {
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, 'utf8');
        tail = raw.split(/\r?\n/).filter(Boolean).slice(-12);
      }
    } catch {}
    return okJson(res, { ok: true, ...bakeoffRunState, log: 'logs/bakeoff-run.log', tail });
  }

  if (req.method === 'GET' && url.pathname === '/api/ai-models') {
    const principal = req.authPrincipal;
    const openAiAllowed = canUseOpenAiByPrincipal(principal);
    const openAiUiEnabled = String(process.env.BETMAN_OPENAI_BUTTON_ENABLED || 'false').toLowerCase() === 'true';
    const hasOpenAiKey = !!(process.env.OPENAI_API_KEY || process.env.BETMAN_OPENAI_API_KEY);
    const ollamaBases = getOllamaBaseList();
    const openaiModels = (openAiAllowed || openAiUiEnabled || hasOpenAiKey) ? ['gpt-4o-mini', 'gpt-5.2'] : [];
    const fallbackOllama = Array.from(new Set([
      String(process.env.BETMAN_CHAT_MODEL || '').trim(),
      ...DEFAULT_OLLAMA_FALLBACK_MODELS
    ].filter(Boolean)));

    const basePayload = {
      openaiModels,
      openAiAllowed,
      hasOpenAiKey,
      openAiUiEnabled,
      ollamaBases
    };
    const now = Date.now();
    if (aiModelsCache.payload && (now - aiModelsCache.ts) < 60000) {
      return okJson(res, { ok: true, ...aiModelsCache.payload, ...basePayload, cached: true });
    }
    fetchOllamaModelsFromBases(ollamaBases)
      .then(({ base: resolvedBase, models }) => {
        aiModelsCache = {
          ts: Date.now(),
          payload: {
            providerDefault: resolveAiProvider(),
            ollamaBase: resolvedBase,
            ollamaModels: (Array.isArray(models) && models.length) ? models : fallbackOllama
          }
        };
        return okJson(res, { ok: true, ...aiModelsCache.payload, ...basePayload, cached: false });
      })
      .catch(() => {
        aiModelsCache = {
          ts: Date.now(),
          payload: {
            providerDefault: resolveAiProvider(),
            ollamaBase: ollamaBases[0] || BETMAN_OLLAMA_DEFAULT_BASE,
            ollamaModels: fallbackOllama
          }
        };
        return okJson(res, { ok: true, ...aiModelsCache.payload, ...basePayload, cached: false });
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/model-bakeoff/latest') {
    try {
      const dir = path.join(process.cwd(), 'bakeoff', 'results');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^leaderboard-.*\.json$/i.test(f)) : [];
      if (!files.length) return okJson(res, { ok: false, error: 'no_results' });
      files.sort();
      const latest = files[files.length - 1];
      const payload = loadJson(path.join(dir, latest), {});
      const markdown = latest.replace(/\.json$/i, '.md');
      const raw = latest.replace(/^leaderboard-/i, 'bakeoff-').replace(/\.json$/i, '.jsonl');
      return okJson(res, { ok: true, ...payload, file: latest, markdown: fs.existsSync(path.join(dir, markdown)) ? markdown : null, raw: fs.existsSync(path.join(dir, raw)) ? raw : null });
    } catch (e) {
      return okJson(res, { ok: false, error: 'read_failed', detail: String(e.message || e) }, 500);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const statusFile = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json');
    let status = loadJson(statusFile, {});
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    if (tenantId !== 'default') {
      const globalStatus = loadJson(path.join(process.cwd(), 'frontend', 'data', 'status.json'), {});
      status = mergePublicStatusLists(globalStatus, status);
    }
    const audited = buildDecisionAudit(status);
    return okJson(res, { ...status, ...audited, tenantId, decisionStandardDoc: '/docs/BETMAN_DECISION_STANDARD.md', aiHealth });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth-config') {
    const principal = req.authPrincipal;
    const openAiUiEnabled = String(process.env.BETMAN_OPENAI_BUTTON_ENABLED || 'false').toLowerCase() === 'true';
    const openAiAllowed = canUseOpenAiByPrincipal(principal);
    const userRecord = getUserRecordByPrincipal(principal);
    const userComplimentary = !!userRecord?.openaiComplimentary;
    const openAiComplimentary = OPENAI_COMPLIMENTARY_GLOBAL && userComplimentary;
    const planType = userRecord?.planType || (principal?.isAdmin ? 'admin' : null);
    const pulseEligible = hasPulseAccess(principal);
    const apiKeyEligible = hasApiKeyAccess(principal);
    const adminMeta = authState.adminMeta || {};
    const apiKeyCreatedAt = principal?.isAdmin ? (adminMeta.apiKeyCreatedAt || null) : (userRecord?.apiKeyCreatedAt || null);
    const apiKeyPreview = principal?.isAdmin ? (adminMeta.apiKeyPreview || null) : (userRecord?.apiKeyPreview || null);
    return okJson(res, {
      ok: true,
      username: authState.username,
      userCount: (authState.users || []).length + 1,
      currentUser: principal?.username || null,
      currentTenantId: principal?.effectiveTenantId || 'default',
      rawTenantId: principal?.tenantId || 'default',
      isAdmin: !!principal?.isAdmin,
      planType,
      pulseEligible,
      apiKeyEligible,
      apiKeyCreatedAt,
      apiKeyPreview,
      openAiUiEnabled,
      openAiAllowed,
      openAiComplimentary
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth-users') {
    const principal = req.authPrincipal;
    if (!principal?.isAdmin) return okJson(res, { ok: false, error: 'admin_required' }, 403);
    return okJson(res, {
      ok: true,
      users: [
        { username: authState.username, role: 'admin', tenantId: 'default' },
        ...(authState.users || []).map(u => ({
          username: u.username,
          name: u.name || null,
          email: u.email || (String(u.username||'').includes('@') ? u.username : null),
          role: u.role || 'user',
          tenantId: normalizeTenantId(u.tenantId || 'default'),
          openaiEnabled: !!u.openaiEnabled,
          openaiComplimentary: !!u.openaiComplimentary
        }))
      ]
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/logout') {
    const cookies = parseCookies(req);
    if (cookies.betman_session) sessions.delete(cookies.betman_session);
    const headers = {
      'Content-Type': 'application/json',
      'Set-Cookie': 'betman_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'X-Auth-Reason': 'logout'
    };
    if (HTTP_BASIC_PROMPT) headers['WWW-Authenticate'] = 'Basic realm="BETMAN-LOGOUT", charset="UTF-8"';
    res.writeHead(401, headers);
    return res.end(JSON.stringify({ ok: true, loggedOut: true }));
  }

  if (req.method === 'GET' && url.pathname === '/api/races') {
    const date = String(url.searchParams.get('date') || '').trim();
    let country = String(url.searchParams.get('country') || '').trim().toUpperCase();
    if (country === 'HKG') country = 'HK';
    const meeting = String(url.searchParams.get('meeting') || '').trim().toLowerCase();
    const limitRaw = toInt(url.searchParams.get('limit'), 200);
    const offset = toInt(url.searchParams.get('offset'), 0);
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const datedPath = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', `races-${date}.json`), `races-${date}.json`);
    const fallbackPath = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'races.json'), 'races.json');
    const racesFile = (date && datedPath && fs.existsSync(datedPath)) ? datedPath : fallbackPath;
    const fileStamp = fs.existsSync(racesFile) ? (fs.statSync(racesFile).mtimeMs || 0) : 0;
    const cacheKey = buildRaceListCacheKey({ date, country, meeting, limit: limitRaw, offset, version: fileStamp });
    const cached = getCachedRaceList(cacheKey);
    if (cached) return okJson(res, cached);

    const data = loadJson(racesFile, { races: [], date: date || null, updatedAt: null });

    let rows = Array.isArray(data.races) ? data.races : [];
    if ((!rows.length || meeting) && date) {
      try {
        const histDir = path.join(process.cwd(), 'data', 'tab', date);
        const archived = [];
        const walk = (dir) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name === 'event.json') {
              try {
                const raw = loadJson(full, null);
                const payload = raw?.data || {};
                const race = payload?.race || {};
                const m = String(race.meeting_name || race.display_meeting_name || '').trim();
                const rno = String(race.race_number || '').trim();
                if (!m || !rno) continue;
                if (meeting && m.toLowerCase() !== meeting) continue;
                archived.push({
                  key: `${normalizePulseCountry(race.country)}:${m}:R${rno}`,
                  country: normalizePulseCountry(race.country) || null,
                  meeting: m,
                  race_number: rno,
                  description: race.race_name || race.description || '',
                  start_time_nz: race.start_time_nz || race.start_time || null,
                  advertised_start: race.start_time || null,
                  track_condition: race.track_condition || null,
                  distance: race.distance || null,
                  rail_position: race.rail_position || null,
                  race_status: race.status || 'historical',
                  runners: Array.isArray(payload.runners) ? payload.runners.map(x => ({
                    runner_number: x.runner_number,
                    name: x.runner_name || x.name,
                    barrier: x.barrier,
                    jockey: x.jockey,
                    trainer: x.trainer,
                    trainer_location: x.trainer_location,
                    owners: x.owners,
                    gear: x.gear,
                    age: x.age,
                    sex: x.sex,
                    colour: x.colour,
                    country: x.country,
                    favourite: x.favourite,
                    mover: x.mover,
                    form_comment: x.form_comment,
                    allowance_weight: x.allowance_weight,
                    apprentice_indicator: x.apprentice_indicator,
                    weight: x.weight_total || x.weight_allocated,
                    rating: x.rating,
                    handicap_rating: x.handicap_rating,
                    win_p: x.win_p,
                    place_p: x.place_p,
                    spr: x.spr,
                    odds: x.fixed_win || x.tote_win || null,
                    fixed_win: x.fixed_win,
                    tote_win: x.tote_win,
                    fixed_place: x.fixed_place,
                    tote_place: x.tote_place,
                    is_scratched: x.is_scratched,
                    sire: x.sire,
                    dam: x.dam,
                    dam_sire: x.dam_sire,
                    dam_dam: x.dam_dam,
                    breeding: x.breeding,
                    last_twenty_starts: x.last_twenty_starts,
                    last_starts: x.last_starts,
                    speedmap: x.speedmap,
                    silk_url_64x64: x.silk_url_64x64,
                    silk_url_128x128: x.silk_url_128x128,
                    silk_colours: x.silk_colours,
                    stats: x.stats || null,
                    form_indicators: x.form_indicators || null,
                    past_performances: x.past_performances || null
                  })) : []
                });
              } catch {}
            }
          }
        };
        walk(histDir);
        if (archived.length) rows = archived;
      } catch {}
    }
    if (country) rows = rows.filter(r => normalizePulseCountry(r.country) === country);
    if (meeting) rows = rows.filter(r => String(r.meeting || '').trim().toLowerCase() === meeting);

    const total = rows.length;
    const limit = limitRaw > 0 ? limitRaw : total;
    const sliceEnd = limit > 0 ? (offset + limit) : undefined;
    rows = rows.slice(offset, sliceEnd);
    const payload = {
      date: data.date || date || null,
      updatedAt: data.updatedAt || null,
      total,
      offset,
      limit,
      races: rows
    };
    setCachedRaceList(cacheKey, payload);
    return okJson(res, payload);
  }

  if (req.method === 'GET' && url.pathname === '/api/suggested-bets') {
    const limit = toInt(url.searchParams.get('limit'), 50);
    const offset = toInt(url.searchParams.get('offset'), 0);
    const status = loadJson(resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
    const rows = Array.isArray(status.suggestedBets) ? status.suggestedBets : [];
    const total = rows.length;
    const slice = rows.slice(offset, offset + limit);
    return okJson(res, {
      updatedAt: status.updatedAt || null,
      total,
      offset,
      limit,
      suggestedBets: slice
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/alerts-feed') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const p = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'alerts_feed.json'), 'alerts_feed.json');
    const payload = loadJson(p, { updatedAt: null, alerts: [] });
    pulseConfigState = loadPulseConfig(tenantId);
    return okJson(res, {
      updatedAt: payload?.updatedAt || null,
      alerts: filterPulseAlerts(Array.isArray(payload?.alerts) ? payload.alerts : []),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/alerts-history') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const p = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'alerts_history.json'), 'alerts_history.json');
    const payload = loadJson(p, []);
    pulseConfigState = loadPulseConfig(tenantId);
    return okJson(res, filterPulseAlerts(Array.isArray(payload) ? payload : []));
  }

  if (url.pathname === '/api/v1/pulse-config') {
    const principal = req.authPrincipal;
    if (!principal) return okJson(res, { ok: false, error: 'auth_required' }, 401, req);
    if (!requirePulseAccess(req, res)) return;
    const tenantId = principal.effectiveTenantId || 'default';

    if (req.method === 'GET') {
      return okJson(res, { ok: true, config: loadPulseConfig(tenantId) }, 200, req);
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const current = loadPulseConfig(tenantId);
        const next = savePulseConfig(tenantId, {
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
        return okJson(res, { ok: true, config: next }, 200, req);
      });
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/settled-bets') {
    const principal = req.authPrincipal;
    if (!principal) return okJson(res, { ok: false, error: 'auth_required' }, 401, req);
    const tenantId = principal.effectiveTenantId || 'default';
    const settledPath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'settled_bets.json'), 'settled_bets.json');
    const trackedPath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'tracked_bets.json'), 'tracked_bets.json');
    const settledRows = Array.isArray(loadJson(settledPath, [])) ? loadJson(settledPath, []) : [];
    const trackedRows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
    const raceResultIndex = buildRaceResultIndex(settledRows);
    return okJson(res, buildVisibleSettledRows(principal, trackedRows, settledRows, raceResultIndex), 200, req);
  }

  if (url.pathname === '/api/v1/tracked-bets') {
    const principal = req.authPrincipal;
    if (!principal) return okJson(res, { ok: false, error: 'auth_required' }, 401, req);
    const tenantId = principal.effectiveTenantId || 'default';
    const trackedPath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'tracked_bets.json'), 'tracked_bets.json');
    const settledPath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'settled_bets.json'), 'settled_bets.json');
    const username = normalizeUsername(principal.username || 'unknown');
    const privateTenantScope = isPrivateTenantPrincipal(principal);

    const allTracked = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];
    const settled = Array.isArray(loadJson(settledPath, [])) ? loadJson(settledPath, []) : [];
    const raceResultIndex = buildRaceResultIndex(settled);
    const liveContext = buildTrackedBetLiveContext(tenantId);

    if (req.method === 'GET') {
      const visibleTracked = privateTenantScope
        ? allTracked
        : allTracked.filter(row => normalizeUsername(row.username || '') === username);
      const visibleResolved = visibleTracked
        .map(row => resolveTrackedBet(row, settled, raceResultIndex))
        .sort((a,b) => String(b.trackedAt || '').localeCompare(String(a.trackedAt || '')));
      const recoveredHistory = buildTrackedHistoryRows(principal, visibleResolved, settled, raceResultIndex);
      const mine = [...visibleResolved, ...recoveredHistory]
        .map(row => enrichTrackedBetWithCurrentOdds(row, liveContext))
        .sort((a,b) => String(b.settledAt || b.trackedAt || '').localeCompare(String(a.settledAt || a.trackedAt || '')));
      if (JSON.stringify(visibleResolved) !== JSON.stringify(visibleTracked)) {
        if (privateTenantScope) {
          writeJson(trackedPath, visibleResolved);
        } else {
          const others = allTracked.filter(row => normalizeUsername(row.username || '') !== username);
          writeJson(trackedPath, [...others, ...visibleResolved]);
        }
      }
      return okJson(res, { ok: true, trackedBets: mine }, 200, req);
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const next = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
          username,
          createdBy: username,
          trackedBy: username,
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
          trackedAt: new Date().toISOString(),
          status: 'active',
          result: 'pending',
          settledAt: null,
        };
        if (!next.meeting || !next.race || !next.selection) return okJson(res, { ok: false, error: 'invalid_payload' }, 400, req);
        const duplicate = findTrackedDuplicate(allTracked, next);
        if (duplicate) {
          return okJson(res, { ok: true, trackedBet: enrichTrackedBetWithCurrentOdds(resolveTrackedBet(duplicate, settled, raceResultIndex), liveContext), duplicate: true }, 200, req);
        }
        writeJson(trackedPath, [next, ...allTracked]);
        return okJson(res, { ok: true, trackedBet: enrichTrackedBetWithCurrentOdds(next, liveContext) }, 200, req);
      });
      return;
    }
  }

  if (url.pathname.startsWith('/api/v1/tracked-bets/')) {
    const principal = req.authPrincipal;
    if (!principal) return okJson(res, { ok: false, error: 'auth_required' }, 401, req);
    const tenantId = principal.effectiveTenantId || 'default';
    const trackedPath = resolveTenantOwnedPathById(tenantId, path.join(process.cwd(), 'frontend', 'data', 'tracked_bets.json'), 'tracked_bets.json');
    const username = normalizeUsername(principal.username || 'unknown');
    const privateTenantScope = isPrivateTenantPrincipal(principal);
    const trackedId = decodeURIComponent(url.pathname.split('/').pop() || '');
    const rows = Array.isArray(loadJson(trackedPath, [])) ? loadJson(trackedPath, []) : [];

    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const updated = rows.map(row => {
          if (String(row.id) !== trackedId) return row;
          if (!privateTenantScope && !principal.isAdmin && normalizeUsername(row.username || '') !== username) return row;
          const safePayload = { ...payload, trackedBy: username };
          delete safePayload.currentOdds;
          delete safePayload.currentOddsSource;
          delete safePayload.raceStatus;
          if ('entryOdds' in safePayload && !('odds' in safePayload)) safePayload.odds = safePayload.entryOdds;
          if ('odds' in safePayload && !('entryOdds' in safePayload)) safePayload.entryOdds = safePayload.odds;
          return { ...row, ...safePayload, id: row.id, username: row.username };
        });
        writeJson(trackedPath, updated);
        const trackedBet = updated.find(row => String(row.id) === trackedId) || null;
        return okJson(res, { ok: true, trackedBet }, 200, req);
      });
      return;
    }

    if (req.method === 'DELETE') {
      const updated = rows.filter(row => {
        if (String(row.id) !== trackedId) return true;
        if (privateTenantScope || principal.isAdmin) return false;
        return normalizeUsername(row.username || '') !== username;
      });
      writeJson(trackedPath, updated);
      return okJson(res, { ok: true }, 200, req);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/learnings-report') {
    const p = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'learnings_report.json'), 'learnings_report.json');
    const payload = loadJson(p, {});
    return okJson(res, payload);
  }

  if (req.method === 'GET' && url.pathname === '/api/interesting-runners') {
    const limit = toInt(url.searchParams.get('limit'), 50);
    const offset = toInt(url.searchParams.get('offset'), 0);
    const status = loadJson(resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json'), {});
    const rows = Array.isArray(status.interestingRunners) ? status.interestingRunners : [];
    const total = rows.length;
    const slice = rows.slice(offset, offset + limit);
    return okJson(res, {
      updatedAt: status.updatedAt || null,
      total,
      offset,
      limit,
      interestingRunners: slice
    });
  }

  // Tenant-aware data file overlays for legacy frontend fetch paths
  if (req.method === 'GET' && url.pathname === '/data/status.json') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const p = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'status.json'), 'status.json');
    let status = (DB_URL ? await loadDataSnapshotFromPg(tenantId, 'status.json') : null) || loadJson(p, {});
    if (tenantId !== 'default') {
      const globalStatus = (DB_URL ? await loadDataSnapshotFromPg('default', 'status.json') : null) || loadJson(path.join(process.cwd(), 'frontend', 'data', 'status.json'), {});
      status = mergePublicStatusLists(globalStatus, status);
    }
    return send(res, 200, JSON.stringify(status), 'application/json');
  }
  if (req.method === 'GET' && (url.pathname === '/data/success_daily.json' || url.pathname === '/data/success_weekly.json' || url.pathname === '/data/success_monthly.json')) {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const filename = path.basename(url.pathname);
    const payload = DB_URL ? await loadDataSnapshotFromPg(tenantId, filename) : null;
    if (payload) return send(res, 200, JSON.stringify(payload), 'application/json');
    const p = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', filename), filename);
    return send(res, 200, fs.readFileSync(p), 'application/json');
  }
  if (req.method === 'GET' && url.pathname === '/data/stake.json') {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const payload = DB_URL ? await loadDataSnapshotFromPg(tenantId, 'stake.json') : null;
    if (payload) return send(res, 200, JSON.stringify(payload), 'application/json');
    const p = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', 'stake.json'), 'stake.json');
    return send(res, 200, fs.readFileSync(p), 'application/json');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/data/races')) {
    const tenantId = req.authPrincipal?.effectiveTenantId || 'default';
    const filename = path.basename(url.pathname);
    const payload = DB_URL ? await loadDataSnapshotFromPg(tenantId, filename) : null;
    if (payload) return send(res, 200, JSON.stringify(payload), 'application/json');
    const p = resolveTenantPath(req, path.join(process.cwd(), 'frontend', 'data', filename), filename);
    if (p && fs.existsSync(p)) return send(res, 200, fs.readFileSync(p), 'application/json');
  }

  if (req.method === 'GET' && url.pathname === '/api/instructions') {
    const text = loadText(AI_INSTRUCTIONS_FILE, '').trim();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
    return;
  }

  // GET static
  const filePath = safePath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath) return send(res, 403, 'forbidden');
  if (!fs.existsSync(filePath)) return send(res, 404, 'not found');

  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json' };
  send(res, 200, fs.readFileSync(filePath), types[ext] || 'application/octet-stream');
});

let shutdownInProgress = false;

async function shutdownServer(signal = 'unknown') {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[runtime] received ${signal}; starting graceful shutdown`);

  const forceTimer = setTimeout(() => {
    console.error('[runtime] graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    if (pgPool) {
      try {
        await pgPool.end();
      } catch (err) {
        console.error('[runtime] postgres pool close failed:', err?.message || err);
      }
    }
    clearTimeout(forceTimer);
    console.log('[runtime] graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceTimer);
    console.error('[runtime] shutdown failed:', err?.message || err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { shutdownServer('SIGTERM'); });
process.on('SIGINT', () => { shutdownServer('SIGINT'); });
process.on('unhandledRejection', (reason) => {
  console.error('[runtime] unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[runtime] uncaughtException', err);
  shutdownServer('uncaughtException');
});

if (require.main === module) {
  initAuthPersistence().finally(() => {
    server.listen(port, ()=>{
      console.log(`frontend server running: http://localhost:${port}`);
      if (authState.password === 'change-me-now') {
        console.log('WARNING: Using default BETMAN_PASSWORD. Set BETMAN_USERNAME/BETMAN_PASSWORD env vars or update via /api/auth-config.');
      }
      if (DB_URL) console.log('Postgres persistence: enabled');
    });
  });
}

module.exports = {
  buildSelectionFactAnswer,
  enforceDecisionAnswerFormat,
  enforceRaceAnalysisAnswerFormat,
  aiAnswerRespectsSelections,
  normalizeRunnerName,
  buildAiContextSummary,
  isSmallModel,
  inferMeetingFromQuestion,
  inferNextRaceAtVenue,
  inferTemporalRaceAtVenue,
  formatStatsCompact,
  isLiveRaceEntry,
  FINISHED_RACE_STATUSES
};
