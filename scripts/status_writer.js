#!/usr/bin/env node
/* Build frontend/data/status.json from poller state */
const fs = require('fs');
const path = require('path');
const { buildSettledBetKey } = require('./tracked_bet_matching');

function loadJson(p, fallback){
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fallback; }
}

const PULSE_SEVERITY_LEVELS = Object.freeze(['WATCH', 'HOT', 'CRITICAL', 'ACTION']);

const DEFAULT_PULSE_CONFIG = Object.freeze({
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
  updatedAt: null,
  updatedBy: null,
});

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

function normalizePulseConfig(raw = {}) {
  const alertTypes = raw && typeof raw.alertTypes === 'object' ? raw.alertTypes : {};
  return {
    alertTypes: {
      plunges: alertTypes.plunges !== false,
      drifts: alertTypes.drifts !== false,
      conflicts: alertTypes.conflicts !== false,
      selectionFlips: alertTypes.selectionFlips !== false,
      preJumpHeat: alertTypes.preJumpHeat !== false,
      jumpPulse: alertTypes.jumpPulse !== false,
    },
    thresholds: normalizePulseThresholds(raw?.thresholds || {}),
    updatedAt: raw?.updatedAt || null,
    updatedBy: raw?.updatedBy || null,
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

function filterPulseAlerts(rows, config) {
  const enabled = config?.alertTypes || DEFAULT_PULSE_CONFIG.alertTypes;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const key = pulseConfigKeyForAlertType(row?.type);
    if (key && enabled[key] === false) return false;
    return pulseAlertPassesThresholds(row, config);
  });
}

function appendJsonl(p, row){
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
  } catch {}
}

function getArg(name, def){
  const idx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (idx === -1) return def;
  return process.argv[idx].split('=').slice(1).join('=') || def;
}

function parseReasonWinProb(reason){
  const raw = String(reason || '');
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*(?:win|chance|prob|probability)/i,
    /win\s*(?:prob|probability)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i,
    /model\s*(?:win\s*)?[:=]?\s*(\d+(?:\.\d+)?)\s*%/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

function inferSignalPct(row){
  const explicitProb = Number(row?.aiWinProb ?? row?.winProb ?? row?.win_prob ?? row?.win_p);
  if (Number.isFinite(explicitProb)) return explicitProb;
  const explicitConfidence = Number(row?.confidenceSignalPct);
  if (Number.isFinite(explicitConfidence)) return explicitConfidence;
  const parsed = parseReasonWinProb(row?.reason);
  if (Number.isFinite(parsed)) return parsed;
  return NaN;
}

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');
const defaultStatePath = path.join(ROOT, 'memory', 'racing-poll-state.json');
const statePath = path.resolve(getArg('state_path', defaultStatePath));
const tenantId = String(process.env.TENANT_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
const isDefaultTenant = tenantId === 'default';
const tenantDataDir = path.join(ROOT, 'memory', 'tenants', tenantId, 'frontend-data');
const tenantMemoryDir = path.join(ROOT, 'memory', 'tenants', tenantId);

const defaultStatusPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'status.json') : path.join(tenantDataDir, 'status.json');
const statusPath = path.resolve(getArg('status_path', defaultStatusPath));
const balancePath = path.join(ROOT, 'memory', 'balance.json');
const stakePath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'stake.json') : path.join(tenantDataDir, 'stake.json');
const feelPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'feel_meter.json') : path.join(tenantDataDir, 'feel_meter.json');
const placedPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'placed_bets.json') : path.join(tenantDataDir, 'placed_bets.json');
const dailyPnlDir = path.join(ROOT, 'memory');
const apiSmokePath = path.join(ROOT, 'memory', 'api-smoke-public.json');
const queuePath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'ai_bet_queue.json') : path.join(tenantDataDir, 'ai_bet_queue.json');
const betPlanAuditPath = isDefaultTenant ? path.join(ROOT, 'memory', 'bet-plan-audit.jsonl') : path.join(tenantMemoryDir, 'bet-plan-audit.jsonl');

const state = loadJson(statePath, null);
if (!state) {
  console.error('No poller state found.');
  process.exit(1);
}

const prevStatus = loadJson(statusPath, null);
const balanceData = loadJson(balancePath, { betcha: { balance: 58.41, openBets: 0 }, tab: { balance: null, openBets: 0 } });
const stakeData = loadJson(stakePath, { stakePerRace: 10, exoticStakePerRace: 1, earlyWindowMin: 180, aiWindowMin: 10, betHarderMultiplier: 1.5 });
const feelData = loadJson(feelPath, { score: 50, wins: 0, losses: 0, updatedAt: '' });
const placedBets = loadJson(placedPath, []);
const queuedBets = loadJson(queuePath, []);
const pulseConfigPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'pulse_config.json') : path.join(tenantDataDir, 'pulse_config.json');
const pulseConfig = normalizePulseConfig(loadJson(pulseConfigPath, DEFAULT_PULSE_CONFIG));

// preserve last known open bets if latest pull failed
if ((balanceData.betcha?.openBets == null || balanceData.tab?.openBets == null) && prevStatus?.openBets != null) {
  balanceData.betcha = balanceData.betcha || {};
  balanceData.tab = balanceData.tab || {};
  if (balanceData.betcha.openBets == null) balanceData.betcha.openBets = prevStatus.openBets;
  if (balanceData.tab.openBets == null) balanceData.tab.openBets = 0;
}

const { buildStatus } = require('./status_writer_impl');

const status = buildStatus(state, balanceData, stakeData.stakePerRace || 10, { stakePath });
status.stakePerRace = stakeData.stakePerRace || 10;
status.exoticStakePerRace = (typeof stakeData.exoticStakePerRace === 'number') ? stakeData.exoticStakePerRace : 1;
status.earlyWindowMin = (typeof stakeData.earlyWindowMin === 'number') ? stakeData.earlyWindowMin : 180;
status.aiWindowMin = (typeof stakeData.aiWindowMin === 'number') ? stakeData.aiWindowMin : 10;
status.betHarderMultiplier = (typeof stakeData.betHarderMultiplier === 'number') ? stakeData.betHarderMultiplier : 1.5;

const nzDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const dailyPnlPath = path.join(dailyPnlDir, `daily-pnl-${nzDate}.json`);
const pnlHistoryPath = path.join(dailyPnlDir, 'pnl-history.json');
const currentTotal = Number(balanceData.betcha?.balance || 0) + Number(balanceData.tab?.balance || 0);
let daily = loadJson(dailyPnlPath, null);
if (!daily || typeof daily.openingTotal !== 'number') {
  daily = { date: nzDate, openingTotal: currentTotal, createdAt: new Date().toISOString() };
}
const pnl = Math.round((currentTotal - Number(daily.openingTotal || 0)) * 100) / 100;
daily.lastTotal = currentTotal;
daily.lastUpdated = new Date().toISOString();
fs.writeFileSync(dailyPnlPath, JSON.stringify(daily, null, 2));

// Long-term daily log snapshot
const hist = loadJson(pnlHistoryPath, []);
const key = String(nzDate);
const nextHist = (hist || []).filter(x => String(x.date) !== key);
nextHist.push({ date: key, openingTotal: daily.openingTotal, lastTotal: currentTotal, pnl, updatedAt: daily.lastUpdated });
nextHist.sort((a,b) => String(a.date).localeCompare(String(b.date)));
fs.writeFileSync(pnlHistoryPath, JSON.stringify(nextHist, null, 2));

status.dailyPnl = pnl;
status.dailyPnlOpening = daily.openingTotal;
status.pnlHistory = nextHist.slice(-7);

const apiSmoke = loadJson(apiSmokePath, null);
const smokeOk = !!(apiSmoke && Array.isArray(apiSmoke.results) && apiSmoke.results.every(r => {
  if (String(r.url || '').includes('/insights/sync') && Number(r.status) === 415) return true;
  return !!r.ok;
}));
status.apiStatus = smokeOk ? 'OK' : 'FAIL';
status.apiStatusPublic = smokeOk ? 'OK' : 'FAIL';
status.apiStatusDetail = {
  smokeOk,
  smokeCheckedAt: apiSmoke?.checkedAt || null
};

function jumpedMoreThanMinutes(r, mins = 5){
  const t = toMs(r?.advertised_start || r?.start_time || r?.startTime || null);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > mins * 60 * 1000;
}

function bestWinOdds(x){
  const f = Number(x?.fixed_win || 0);
  if (Number.isFinite(f) && f > 0) return f;
  const t = Number(x?.tote_win || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return NaN;
}

// derive interesting runners from long-odds + good-form candidates (if any)
const fromCandidates = (state.candidates || []).map(c=>{
  const raceObj = (state.races || {})[c.race] || null;
  const eta = raceObj ? etaFromRace(raceObj) : minsToEnglish(c.mins_to_start);
  const stale = raceObj ? jumpedMoreThanMinutes(raceObj, 5) : (Number(c.mins_to_start) < -5);
  return {
    meeting: c.race.split(':')[1],
    race: c.race.split(':')[2].replace('R',''),
    runner: c.runner,
    odds: c.odds,
    eta,
    stale,
    reason: `long-odds + form (${c.last})`
  };
});
const mapPlanToInteresting = (b, source='plan') => {
  const raceObj = (state.races || {})[b.race] || null;
  const eta = raceObj ? etaFromRace(raceObj) : minsToEnglish(b.mins_to_start);
  const stale = raceObj ? jumpedMoreThanMinutes(raceObj, 5) : (Number(b.mins_to_start) < -5);
  return {
    meeting: b.race.split(':')[1],
    race: b.race.split(':')[2].replace('R',''),
    runner: b.selection,
    odds: b.odds,
    eta,
    stale,
    reason: `${source} ${b.bet_type} @ ${b.odds}`
  };
};

const fromPlans = (state.bet_plans || []).map(b => mapPlanToInteresting(b, 'plan'));
const fromEarlyPlans = (state.early_plans || []).map(b => mapPlanToInteresting(b, 'early-plan'));

function etaFromRace(r){
  const t = toMs(r?.advertised_start || r?.start_time || r?.startTime || null);
  if (!Number.isFinite(t)) return 'upcoming';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'jumped';
  return `in ${mins}m`;
}

const racesEntries = Object.entries(state.races || {});
const racesList = racesEntries.map(([, v]) => v || {});
const raceCountryByMeetingRace = new Map();
const raceCountryByMeeting = new Map();
racesEntries.forEach(([key, r]) => {
  const mk = String(r?.meeting || '').trim().toLowerCase();
  const rk = String(r?.race_number || '').trim();
  const fromRow = String(r?.country || '').trim().toUpperCase();
  const fromKey = String(key || '').split(':')[0].trim().toUpperCase();
  const c = fromRow || (['NZ','AUS','HK'].includes(fromKey) ? fromKey : '');
  if (mk && rk && c) raceCountryByMeetingRace.set(`${mk}|${rk}`, c);
  if (mk && c && !raceCountryByMeeting.has(mk)) raceCountryByMeeting.set(mk, c);
});
function inferCountry(meeting, race){
  const mk = String(meeting || '').trim().toLowerCase();
  const rk = String(race || '').replace(/^R/i, '').trim();
  return raceCountryByMeetingRace.get(`${mk}|${rk}`) || raceCountryByMeeting.get(mk) || '';
}
function withCountry(row){
  const direct = String(row?.country || '').trim().toUpperCase();
  if (direct) return row;
  const inferred = inferCountry(row?.meeting, row?.race);
  return inferred ? { ...row, country: inferred } : row;
}

// fallback interesting runners from open races: long odds >= 8 with visible form string
const fallbackInteresting = Object.values(state.races || []).flatMap(r =>
  (r.runners || [])
    .filter(x => {
      const o = bestWinOdds(x);
      return Number.isFinite(o) && o >= 8;
    })
    .slice(0, 2)
    .map(x => {
      const o = bestWinOdds(x);
      return {
        meeting: r.meeting,
        race: r.race_number,
        runner: x.runner_name,
        odds: Number.isFinite(o) ? o : null,
        eta: etaFromRace(r),
        stale: jumpedMoreThanMinutes(r, 5),
        reason: `watchlist long-odds`
      };
    })
);

status.interestingRunners = [...fromCandidates, ...fromPlans, ...fromEarlyPlans, ...fallbackInteresting]
  .filter(x => !x.stale)
  .map(({ stale, ...rest }) => withCountry(rest))
  .filter(x => String(x?.country || '').trim())
  .reduce((acc, x) => {
    const k = `${String(x.meeting)}|${String(x.race)}|${String(x.runner).toLowerCase()}`;
    if (!acc.map.has(k)) {
      acc.map.set(k, true);
      acc.rows.push(x);
    }
    return acc;
  }, { map: new Map(), rows: [] }).rows
  .slice(0, 80);

const interestingKeySet = new Set((status.interestingRunners || []).map(x =>
  `${String(x.meeting || '').trim().toLowerCase()}|${String(x.race || '').trim()}|${String(x.runner || '').trim().toLowerCase()}`
));

const maxMainStake = Number(stakeData.stakePerRace || 10);
const maxExoticStake = Number((typeof stakeData.exoticStakePerRace === 'number') ? stakeData.exoticStakePerRace : 1);
const strongSignalMultiplier = 1.2;

function isStrongSignal(entry){
  const wp = Number(entry?.win_prob);
  if (Number.isFinite(wp) && wp >= 35) return true;
  if (entry?.standout === true) return true;
  const edge = Number(entry?.edge_ratio || entry?.standout_ratio || 0);
  if (Number.isFinite(edge) && edge >= 1.8) return true;
  return false;
}

function capStakeForType(type, stake, entry){
  const n = Number(stake || 0);
  if (!Number.isFinite(n)) return 0;
  const t = String(type || '').toLowerCase();
  const isExotic = ['top2','top3','top4','trifecta','multi'].includes(t);
  const baseCap = isExotic ? maxExoticStake : maxMainStake;
  const cap = (!isExotic && isStrongSignal(entry)) ? (baseCap * strongSignalMultiplier) : baseCap;
  return Math.max(0, Math.min(n, cap));
}

function clamp(n, lo, hi){
  return Math.max(lo, Math.min(hi, n));
}

function computeWinSignalScore(winProbPct, odds){
  const p = Number(winProbPct);
  const o = Number(odds);
  if (Number.isFinite(p) && Number.isFinite(o) && o > 0) {
    const implied = 100 / o;
    return clamp(Math.round(50 + ((p - implied) * 2.2)), 5, 95);
  }
  if (Number.isFinite(p)) return clamp(Math.round(p * 2.4), 5, 95);
  return null;
}

function computeFallbackSignalScore(odds){
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 0) return null;
  const implied = 100 / o;
  return clamp(Math.round(25 + (implied * 1.1)), 25, 80);
}

function normalizeBetType(type){
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'win';
  if (t === 'each-way') return 'ew';
  return t.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '_');
}

function round2(v){
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function deriveEdgePct(winProbPct, odds){
  const p = Number(winProbPct);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 0) return null;
  const implied = 100 / o;
  return round2(p - implied);
}

function deriveKellyFraction(winProbPct, odds){
  const pRaw = Number(winProbPct);
  const o = Number(odds);
  if (!Number.isFinite(pRaw) || !Number.isFinite(o) || o <= 1) return null;
  const p = pRaw / 100;
  const b = o - 1;
  const q = 1 - p;
  const k = ((b * p) - q) / b;
  return round2(Math.max(0, Math.min(k, 1)));
}

function buildExecutionMeta(entry = {}){
  const type = normalizeBetType(entry.type || entry.bet_type);
  const edgePct = Number.isFinite(Number(entry.edge ?? entry.edgePct ?? entry.edge_pct))
    ? Number(entry.edge ?? entry.edgePct ?? entry.edge_pct)
    : deriveEdgePct(entry.aiWinProb ?? entry.win_prob ?? entry.confidenceSignalPct, entry.odds);
  const signalPct = inferSignalPct(entry);
  const odds = Number(entry.odds);
  const isExotic = ['top2','top3','top4','trifecta','multi'].includes(type);
  const strong = isStrongSignal(entry);

  const mainWinEligible = Number.isFinite(signalPct) && Number.isFinite(edgePct) && signalPct >= 65 && edgePct >= 6;
  const secondaryWinEligible = Number.isFinite(signalPct) && Number.isFinite(edgePct) && signalPct >= 58 && edgePct >= 4;
  const toxicLowEdge = Number.isFinite(edgePct) && edgePct >= 0 && edgePct < 2;
  const toxicMidOddsLowEdge = Number.isFinite(odds) && odds >= 5 && odds <= 8 && Number.isFinite(edgePct) && edgePct >= 2 && edgePct < 4;
  const toxicModelBand = Number.isFinite(signalPct) && signalPct >= 20 && signalPct <= 25;

  const eligible = isExotic
    ? (Number(entry.stake || 0) > 0)
    : (mainWinEligible || secondaryWinEligible) && !toxicLowEdge && !toxicMidOddsLowEdge && !toxicModelBand;

  let executionRoute = 'NO_BET';
  let executionRouteConfidence = 'low';
  let recommendedAction = eligible ? 'WATCH' : 'NO_BET';
  let executionBlockReason = null;

  if (eligible) {
    if (isExotic) {
      executionRoute = 'EXOTIC';
      executionRouteConfidence = strong ? 'high' : 'medium';
      recommendedAction = 'QUEUE';
    } else if (odds >= 8 && type === 'ew') {
      executionRoute = 'FIXED';
      executionRouteConfidence = 'medium';
      recommendedAction = strong ? 'BET_NOW' : 'QUEUE';
    } else if (odds > 0) {
      executionRoute = odds <= 3.5 ? 'TOTE' : 'FIXED';
      executionRouteConfidence = mainWinEligible ? 'high' : 'medium';
      recommendedAction = mainWinEligible ? 'BET_NOW' : 'QUEUE';
    }
  } else {
    if (!Number.isFinite(signalPct) || signalPct < 58) executionBlockReason = 'signal_below_threshold';
    else if (!Number.isFinite(edgePct) || edgePct < 4) executionBlockReason = 'edge_below_threshold';
    else if (toxicLowEdge) executionBlockReason = 'toxic_low_edge_bucket';
    else if (toxicMidOddsLowEdge) executionBlockReason = 'toxic_mid_odds_low_edge_bucket';
    else if (toxicModelBand) executionBlockReason = 'toxic_model_band_20_25';
    else executionBlockReason = 'policy_blocked';
  }

  return {
    betType: type,
    edge: round2(edgePct),
    kellyFraction: deriveKellyFraction(entry.aiWinProb ?? entry.win_prob ?? entry.confidenceSignalPct, entry.odds),
    executionEligible: !!eligible,
    recommendedAction,
    executionRoute,
    executionRouteConfidence,
    executionBlockReason
  };
}

function enrichSuggestedEntry(entry = {}){
  const meta = buildExecutionMeta(entry);
  const raceNumber = entry.raceNumber ?? entry.race ?? null;
  const type = meta.betType;
  let capitalTier = 'blocked';
  let capitalIntent = 'Blocked';
  if (meta.recommendedAction === 'BET_NOW') {
    capitalTier = 'bet_now';
    capitalIntent = 'Bet Now';
  } else if (meta.recommendedAction === 'QUEUE') {
    capitalTier = 'queue';
    capitalIntent = 'Queue';
  } else if (entry.interesting || meta.recommendedAction === 'WATCH') {
    capitalTier = 'watchlist';
    capitalIntent = 'Watchlist';
  }
  return {
    ...entry,
    race: raceNumber,
    raceNumber,
    type,
    betType: type,
    confidenceSignalPct: Number.isFinite(Number(entry.confidenceSignalPct)) ? Number(entry.confidenceSignalPct) : inferSignalPct(entry),
    capitalTier,
    capitalIntent,
    ...meta
  };
}

function computeExoticSignalScore(plan){
  const selections = Array.isArray(plan?.selections) ? plan.selections : [];
  const probs = selections
    .map(s => Number(s?.win_prob))
    .filter(v => Number.isFinite(v) && v > 0)
    .slice(0, 2);
  if (probs.length) {
    const avgTopTwo = probs.reduce((a, b) => a + b, 0) / probs.length;
    return clamp(Math.round(avgTopTwo * 2.2), 10, 90);
  }
  const market = String(plan?.market || '').toLowerCase();
  if (market === 'trifecta') return 48;
  if (['top2','top3','top4','multi'].includes(market)) return 42;
  return null;
}

function minsToEnglish(v){
  const n = Number(v);
  if (!Number.isFinite(n)) return 'upcoming';
  const rounded = Math.round(n);
  if (rounded <= 0) return 'jumped';
  if (rounded === 1) return 'in 1m';
  return `in ${rounded}m`;
}

let suggested = [...(state.early_plans || []), ...(state.bet_plans || [])].map(b=>({
  meeting: b.race.split(':')[1],
  race: b.race.split(':')[2].replace('R',''),
  selection: b.selection,
  type: b.bet_type,
  aiWinProb: Number.isFinite(Number(b.win_prob)) ? Number(b.win_prob) : null,
  confidenceSignalPct: Number.isFinite(Number(b.win_prob)) ? Number(b.win_prob) : null,
  signal_score: computeWinSignalScore(Number(b.win_prob), Number(b.odds)),
  stake: capStakeForType(b.bet_type, b.stake, b),
  odds: b.odds ?? null,
  place_odds: b.place_odds ?? null,
  jumpsIn: minsToEnglish(b.mins_to_start),
  reason: `p=${b.win_prob || ''}% @ ${b.odds}`,
  tags: Array.isArray(b.tags) ? b.tags : [],
  pedigreeTag: b.pedigreeTag || null,
  pedigreeScore: b.pedigreeScore ?? null,
  pedigreeConfidence: b.pedigreeConfidence ?? null,
  pedigreeRelativeEdge: b.pedigreeRelativeEdge ?? null,
  pedigreeArchetype: b.pedigreeArchetype || null
}));

// fallback suggested bets from top market runners if no plans in window
if (!suggested.length) {
  const modelSignals = state.model_signals || {};
  suggested = Object.entries(state.races || {}).slice(0, 10).flatMap(([raceKey, r]) => {
    const signal = modelSignals[raceKey];
    if (signal && signal.selection) {
      const odds = Number(signal.odds);
      const betType = String(signal.bet_type || 'Win');
      const winProb = Number(signal.win_prob);
      return [{
        meeting: signal.meeting || r.meeting,
        race: signal.race || r.race_number,
        country: r.country || null,
        selection: signal.selection,
        type: betType,
        stake: capStakeForType(betType, stakeData.stakePerRace || 10, signal),
        odds: Number.isFinite(odds) ? odds : null,
        place_odds: null,
        signal_score: Number(signal.signal_score) || computeFallbackSignalScore(Number.isFinite(odds) ? odds : 0),
        aiWinProb: Number.isFinite(winProb) ? winProb : null,
        jumpsIn: etaFromRace(r),
        tags: Array.isArray(signal.tags) ? signal.tags : [],
        reason: signal.reason || `model ${Number.isFinite(winProb) ? winProb.toFixed(1) : '—'}% @ $${Number.isFinite(odds) ? odds.toFixed(2) : '—'}`
      }];
    }
    const top = (r.runners || [])
      .filter(x => x.fixed_win)
      .sort((a,b)=>a.fixed_win-b.fixed_win)
      .slice(0,1);
    return top.map(x => {
      const odds = Number(x.fixed_win);
      const betType = odds >= 8 ? 'EW' : 'Win';
      const confidence = odds <= 3 ? 'high' : (odds <= 6 ? 'medium' : 'speculative');
      return {
        meeting: r.meeting,
        race: r.race_number,
        selection: x.runner_name,
        type: betType,
        stake: stakeData.stakePerRace || 10,
        odds,
        place_odds: null,
        signal_score: computeFallbackSignalScore(odds),
        jumpsIn: etaFromRace(r),
        reason: `fallback ${confidence} profile · market leader @ $${odds.toFixed(2)}`
      };
    });
  }).slice(0, 10);
}
const exoticSuggested = (state.exotic_plans || []).map(x => {
  const [_, meeting, raceCode] = x.race.split(':');
  const race = String(raceCode || '').replace('R','');
  let selection = '';
  if (x.selections && x.selections.length) {
    selection = x.selections.map(s => s.selection).join(' / ');
  } else if (x.structure) {
    selection = `${x.structure.first} > ${x.structure.second_third_box.join(' / ')}`;
  }
  const winProb = Array.isArray(x.selections)
    ? x.selections.map(s => Number(s?.win_prob)).filter(v => Number.isFinite(v) && v > 0).reduce((a,b)=>a+b,0)
    : NaN;
  return {
    meeting,
    race,
    selection,
    type: x.market,
    stake: capStakeForType(x.market, x.stake, x),
    signal_score: computeExoticSignalScore(x),
    aiWinProb: Number.isFinite(winProb) ? Math.min(95, Math.round(winProb * 10) / 10) : null,
    jumpsIn: minsToEnglish(x.mins_to_start),
    reason: `${x.note || 'exotic profile'} · ${minsToEnglish(x.mins_to_start)}`
  };
});

status.suggestedBets = [...suggested, ...exoticSuggested].map(x => {
  const withCBase = withCountry(x);
  const k = `${String(withCBase.meeting || '').trim().toLowerCase()}|${String(withCBase.race || '').trim()}|${String(withCBase.selection || '').trim().toLowerCase()}`;
  const isInteresting = interestingKeySet.has(k);
  const decorated = isInteresting
    ? { ...withCBase, interesting: true, interestingReason: 'matched interesting runner profile' }
    : withCBase;
  return enrichSuggestedEntry(decorated);
}).filter(x => String(x?.country || '').trim())
  .filter(x => {
    if (['top2','top3','top4','trifecta','multi'].includes(String(x?.betType || x?.type || '').toLowerCase())) return true;
    if (x.executionEligible) return true;
    return !!x.interesting;
  });

status.noBetPolicy = 'Main bet = edge ≥ 6 pts and confidence ≥ 65. Secondary bet = edge ≥ 4 pts and confidence ≥ 58. Toxic low-edge and unstable 20–25% model bands are blocked.';
const nonExoticSuggested = (status.suggestedBets || []).filter(x => !['top2','top3','top4','trifecta','multi'].includes(String(x?.betType || x?.type || '').toLowerCase()));
status.noBetCount = nonExoticSuggested.filter(x => !x.executionEligible).length;
status.betAllowedCount = nonExoticSuggested.filter(x => x.executionEligible).length;
status.exoticAllowedCount = (status.suggestedBets || []).filter(x => ['top2','top3','top4','trifecta','multi'].includes(String(x?.betType || x?.type || '').toLowerCase()) && x.executionEligible).length;
status.feelMeter = feelData;

const raceByKey = Object.fromEntries(Object.entries(state.races || {}).map(([k,v])=>[`${v.meeting}:R${v.race_number}`, v]));

function normSel(s){
  const raw = String(s || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
  // Canonicalize composite selections (multi/exotics) so delimiters/order don't cause false mismatches.
  const parts = raw.split(/\s(?:x|\/|>)\s/g).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.sort().join(' x ');
  return raw;
}
function normMeeting(s){
  return String(s || '').trim().toLowerCase();
}

const aiIndex = new Map();
for (const s of (status.suggestedBets || [])) {
  const key = `${normMeeting(s.meeting)}|${String(s.race)}|${normSel(s.selection)}`;
  const cur = aiIndex.get(key) || { stake: 0, types: new Set() };
  cur.stake += Number(s.stake || 0);
  cur.types.add(String(s.type || ''));
  aiIndex.set(key, cur);
}

// upcoming bets = queued first, then placed
function toMs(raw){
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (/^\d+$/.test(String(raw))) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? NaN : t;
}
const nowMs = Date.now();
const graceMs = 10 * 60 * 1000; // hide bets 10 min after jump if not explicitly settled elsewhere

const queuedRows = (queuedBets || []).map(x => {
  const rk = `${x.meeting}:R${x.race}`;
  const rv = raceByKey[rk] || {};
  return {
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    stake: x.stake,
    type: `${x.type} (Queued)` ,
    odds: x.odds || '',
    eta: x.placeAfter || x.eta || rv.start_time_nz || 'upcoming',
    sortTime: x.placeAfterMs || x.sortTime || rv.advertised_start || rv.start_time_nz || '',
    source: x.source || 'AI'
  };
}).filter(x => {
  const t = toMs(x.sortTime || x.eta);
  return Number.isNaN(t) ? true : (t + graceMs >= nowMs);
});

const placedRowsAll = (placedBets || []).map(x => {
  const rk = `${x.meeting}:R${x.race}`;
  const rv = raceByKey[rk] || {};
  return {
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    stake: x.stake,
    type: x.type,
    odds: x.odds || '',
    eta: x.eta || rv.start_time_nz || 'upcoming',
    sortTime: x.sortTime || rv.advertised_start || rv.start_time_nz || '',
    source: x.source || '',
    placedAt: x.placedAt || null,
    queuedAt: x.queuedAt || null
  };
});

const placedRows = placedRowsAll.filter(x => {
  const t = toMs(x.sortTime || x.eta);
  return Number.isNaN(t) ? true : (t + graceMs >= nowMs);
});

status.upcomingBets = [...queuedRows, ...placedRows];

const betResultsPath = path.join(ROOT, 'frontend', 'data', 'bet_results.json');
const betResults = loadJson(betResultsPath, []);
const settledBetsPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'settled_bets.json') : path.join(tenantDataDir, 'settled_bets.json');
const settledBets = loadJson(settledBetsPath, []);
const settledMap = new Map((settledBets || []).map(r => [buildSettledBetKey(r), r]));
const resMap = new Map((betResults || []).map(r => [`${String(r.meeting).toLowerCase()}|${String(r.race)}|${String(r.selection).toLowerCase()}`, r.result]));
const settledRaceKeys = new Set([
  ...(Array.isArray(settledBets) ? settledBets : []).map(r => `${String(r?.meeting || '').trim().toLowerCase()}|${String(r?.race || '').replace(/^R/i,'').trim()}`),
  ...(Array.isArray(betResults) ? betResults : []).map(r => `${String(r?.meeting || '').trim().toLowerCase()}|${String(r?.race || '').replace(/^R/i,'').trim()}`),
].filter(Boolean));

function isRaceSettledForAlerts(meeting, race, minsToJump){
  const key = `${String(meeting || '').trim().toLowerCase()}|${String(race || '').replace(/^R/i,'').trim()}`;
  if (settledRaceKeys.has(key)) return true;
  if (Number.isFinite(minsToJump) && minsToJump <= -20) return true;
  return false;
}

status.completedBets = placedRowsAll
  .filter(x => {
    const t = toMs(x.sortTime || x.eta);
    return Number.isFinite(t) && (t + graceMs < nowMs);
  })
  .sort((a,b) => toMs(b.sortTime || b.eta) - toMs(a.sortTime || a.eta))
  .slice(0, 50)
  .map(x => {
    const settled = settledMap.get(buildSettledBetKey(x));
    return {
      ...x,
      result: settled?.result || resMap.get(`${String(x.meeting).toLowerCase()}|${String(x.race)}|${String(x.selection).toLowerCase()}`) || 'pending',
      returnUnits: settled?.return_units ?? null,
      profitUnits: settled?.profit_units ?? null,
      roi: settled?.roi ?? null,
      position: settled?.position ?? null,
      winner: settled?.winner ?? null,
      pick_bucket: settled?.pick_bucket ?? null,
      is_long: settled?.is_long ?? null
    };
  });

const wl = status.completedBets.reduce((acc, b) => {
  if (b.result === 'win') acc.wins += 1;
  else if (b.result === 'loss') acc.losses += 1;
  else if (b.result === 'ew_win') acc.ewWins += 1;
  else if (b.result === 'ew_place') acc.ewPlaces += 1;
  else if (b.result === 'ew_loss') acc.ewLosses += 1;
  return acc;
}, { wins: 0, losses: 0, ewWins: 0, ewPlaces: 0, ewLosses: 0 });
status.completedWinLoss = wl;

const placedAgg = new Map();
for (const x of (placedBets || [])) {
  const race = String(x.race).replace(/^R/i,'');
  const key = `${normMeeting(x.meeting)}|${race}|${normSel(x.selection)}`;
  const cur = placedAgg.get(key) || {
    meeting: x.meeting,
    race,
    selection: x.selection,
    placedStake: 0,
    hasAiSource: false
  };
  cur.placedStake += Number(x.stake || 0);
  if (String(x.source || '').toLowerCase().includes('ai')) cur.hasAiSource = true;
  placedAgg.set(key, cur);
}

const placedComparison = Array.from(placedAgg.entries()).map(([key, x]) => {
  const ai = aiIndex.get(key);
  const derivedAiStake = x.hasAiSource ? x.placedStake : 0;
  const aiStake = ai ? Number(ai.stake || 0) : derivedAiStake;
  const pct = aiStake > 0 ? Math.round((x.placedStake / aiStake) * 100) : null;

  const rk = `${x.meeting}:R${x.race}`;
  const rv = raceByKey[rk] || {};
  const raceTs = toMs(rv.advertised_start || rv.start_time_nz || '');

  return {
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    aiStake,
    placedStake: Math.round(x.placedStake * 100) / 100,
    pctBetVsAi: pct,
    matchesAiSelection: Boolean(ai) || x.hasAiSource,
    aiTypes: ai ? Array.from(ai.types) : (x.hasAiSource ? ['AI'] : []),
    raceTs
  };
}).filter(x => {
  // keep only current/future races and very recent (<=15m) completed races
  if (!Number.isFinite(x.raceTs)) return false;
  return x.raceTs + (15 * 60 * 1000) >= nowMs;
});

status.aiBetComparison = placedComparison;

// Market movers: compare current fixed odds snapshot vs previous snapshot from status.json
const prevSnap = prevStatus?.marketOddsSnapshot || {};
const prevSeen = prevStatus?.marketMoverSeen || {};
const prevHistory = prevStatus?.marketOddsHistory || {};
const prevOpening = prevStatus?.marketOddsOpening || {};
const nextSeen = { ...prevSeen };
const nextSnap = {};
const nextHistory = {};
const nextOpening = { ...prevOpening };
const movers = [];
const moverWatch = [];
const MOVER_THRESHOLD_PCT = 1.5; // catch earlier moves
const PRIORITY_WINDOW_MIN = 90;  // prioritize races jumping within this window
const HISTORY_MAX_MS = 12 * 60 * 60 * 1000; // retain 12h of price history for horizon calculations

function bestWinOdds(x){
  const f = Number(x?.fixed_win || x?.odds || 0);
  if (Number.isFinite(f) && f > 0) return f;
  const t = Number(x?.tote_win || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return NaN;
}

function pctFromHistory(hist, nowTs, currentOdds, mins) {
  if (!Array.isArray(hist) || !hist.length) return null;
  const targetTs = nowTs - (mins * 60 * 1000);
  let point = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (Number(h?.ts || 0) <= targetTs) { point = h; break; }
  }
  if (!point) return null;
  const prev = Number(point.odds || 0);
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(currentOdds) || currentOdds <= 0) return null;
  const pct = ((currentOdds - prev) / prev) * 100;
  return Math.round(pct * 10) / 10;
}

for (const [raceKey, race] of Object.entries(state.races || {})) {
  const eta = etaFromRace(race);
  const raceTs = toMs(race?.advertised_start || race?.start_time || race?.startTime || null);
  const minsToJump = Number.isFinite(raceTs) ? Math.round((raceTs - Date.now()) / 60000) : null;

  for (const rr of (race.runners || [])) {
    const name = String(rr.runner_name || rr.name || '').trim();
    const odds = bestWinOdds(rr);
    if (!name || !Number.isFinite(odds) || odds <= 0) continue;
    const k = `${raceKey}|${name.toLowerCase()}`;
    nextSnap[k] = odds;
    const openingOdds = Number(nextOpening[k]);
    if (!Number.isFinite(openingOdds) || openingOdds <= 0) nextOpening[k] = odds;

    const nowTs = Date.now();
    const histPrev = Array.isArray(prevHistory[k]) ? prevHistory[k] : [];
    const hist = histPrev
      .filter(h => Number(h?.ts || 0) >= (nowTs - HISTORY_MAX_MS))
      .concat([{ ts: nowTs, odds }]);
    nextHistory[k] = hist;

    const change1m = pctFromHistory(hist, nowTs, odds, 1);
    const change5m = pctFromHistory(hist, nowTs, odds, 5);
    const change30m = pctFromHistory(hist, nowTs, odds, 30);
    const change1h = pctFromHistory(hist, nowTs, odds, 60);
    const change5h = pctFromHistory(hist, nowTs, odds, 300);

    const prev = Number(prevSnap[k]);
    const opening = Number(nextOpening[k]);
    const changeOpen = (Number.isFinite(opening) && opening > 0 && opening !== odds)
      ? ((odds - opening) / opening) * 100
      : null;
    const instantPct = (Number.isFinite(prev) && prev > 0 && prev !== odds)
      ? ((odds - prev) / prev) * 100
      : null;

    const horizonCandidates = [change1m, change5m, change30m, change1h, change5h, changeOpen]
      .filter(v => Number.isFinite(v))
      .sort((a,b) => Math.abs(b) - Math.abs(a));

    const useInstant = Number.isFinite(instantPct) && Math.abs(instantPct) >= MOVER_THRESHOLD_PCT;
    const chosenPct = useInstant
      ? instantPct
      : (horizonCandidates.find(v => Math.abs(v) >= MOVER_THRESHOLD_PCT) ?? null);

    if (!Number.isFinite(chosenPct)) {
      const watchPct = horizonCandidates.find(v => Math.abs(v) >= 0.6) ?? null;
      if (Number.isFinite(watchPct)) {
        const fromWatch = odds / (1 + (watchPct / 100));
        moverWatch.push({
          meeting: race.meeting,
          race: race.race_number,
          runner: name,
          fromOdds: Math.round(fromWatch * 100) / 100,
          toOdds: Math.round(odds * 100) / 100,
          pctMove: Math.round(watchPct * 10) / 10,
          direction: watchPct < 0 ? 'firm' : 'drift',
          eta,
          minsToJump,
          fresh: false,
          change1m,
          change5m,
          change30m,
          change1h,
          change5h,
          changeOpening: Number.isFinite(changeOpen) ? Math.round(changeOpen * 10) / 10 : null
        });
      }
      continue; // no meaningful move
    }

    const seen = prevSeen[k] || { streak: 0, firstSeenAt: null, lastSeenAt: null };
    const streak = Number(seen.streak || 0) + 1;
    const firstSeenAt = seen.firstSeenAt || new Date().toISOString();
    const lastSeenAt = new Date().toISOString();
    nextSeen[k] = { streak, firstSeenAt, lastSeenAt };

    const derivedFromPct = (Number.isFinite(chosenPct))
      ? (odds / (1 + (chosenPct / 100)))
      : NaN;
    const fromRaw = (useInstant && Number.isFinite(prev) && prev > 0)
      ? prev
      : derivedFromPct;

    movers.push({
      meeting: race.meeting,
      race: race.race_number,
      runner: name,
      fromOdds: Math.round(fromRaw * 100) / 100,
      toOdds: Math.round(odds * 100) / 100,
      pctMove: Math.round(chosenPct * 10) / 10,
      direction: chosenPct < 0 ? 'firm' : 'drift',
      eta,
      minsToJump,
      fresh: streak <= 2,
      change1m,
      change5m,
      change30m,
      change1h,
      change5h,
      changeOpening: Number.isFinite(changeOpen) ? Math.round(changeOpen * 10) / 10 : null
    });
  }
}

const sortMovers = (arr) => arr
  .sort((a,b) => {
    const aPri = (Number.isFinite(a.minsToJump) && a.minsToJump >= 0 && a.minsToJump <= PRIORITY_WINDOW_MIN) ? 0 : 1;
    const bPri = (Number.isFinite(b.minsToJump) && b.minsToJump >= 0 && b.minsToJump <= PRIORITY_WINDOW_MIN) ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    if (Number.isFinite(a.minsToJump) && Number.isFinite(b.minsToJump)) return a.minsToJump - b.minsToJump;
    return Math.abs(b.pctMove) - Math.abs(a.pctMove);
  })
  .slice(0, 80);

status.marketMovers = (movers.length ? sortMovers(movers) : sortMovers(moverWatch)).map(withCountry).filter(x => String(x?.country || '').trim());
status.marketMoverSeen = nextSeen;
status.marketOddsSnapshot = nextSnap;
status.marketOddsHistory = nextHistory;
status.marketOddsOpening = nextOpening;

const trackedBetsPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'tracked_bets.json') : path.join(tenantDataDir, 'tracked_bets.json');
const trackedBetsRaw = loadJson(trackedBetsPath, []);
const trackedBets = Array.isArray(trackedBetsRaw) ? trackedBetsRaw : [];
const trackedRunnerKeys = new Set(
  trackedBets
    .filter(row => String(row?.status || 'active').toLowerCase() !== 'settled')
    .map(row => `${String(row?.meeting || '').trim().toLowerCase()}|${String(row?.race || '').replace(/^R/i,'').trim()}|${String(row?.selection || '').trim().toLowerCase()}`)
    .filter(Boolean)
);

function runnerRoleForAlert(meeting, race, runner) {
  const m = String(meeting || '').trim().toLowerCase();
  const r = String(race || '').replace(/^R/i,'').trim();
  const n = String(runner || '').trim().toLowerCase();
  const suggested = (status.suggestedBets || []).find(x =>
    String(x?.meeting || '').trim().toLowerCase() === m &&
    String(x?.race || '').replace(/^R/i,'').trim() === r &&
    String(x?.selection || '').trim().toLowerCase() === n
  );
  if (suggested) return String(suggested.type || 'suggested').toLowerCase();
  const interesting = (status.interestingRunners || []).find(x =>
    String(x?.meeting || '').trim().toLowerCase() === m &&
    String(x?.race || '').replace(/^R/i,'').trim() === r &&
    String(x?.selection || x?.runner || '').trim().toLowerCase() === n
  );
  if (interesting) return 'interesting';
  return 'market';
}

function isTrackedRunnerAlert(meeting, race, runner) {
  const key = `${String(meeting || '').trim().toLowerCase()}|${String(race || '').replace(/^R/i,'').trim()}|${String(runner || '').trim().toLowerCase()}`;
  return trackedRunnerKeys.has(key);
}

const basePulseAlerts = (status.marketMovers || []).map((x, idx) => {
  const move = Number(x?.pctMove || 0);
  const minsToJump = Number(x?.minsToJump);
  const raceSettled = isRaceSettledForAlerts(x.meeting, x.race, minsToJump);
  const absMove = Math.abs(move);
  const role = runnerRoleForAlert(x.meeting, x.race, x.runner);
  const trackedRunner = isTrackedRunnerAlert(x.meeting, x.race, x.runner);
  const linkedSuggested = (status.suggestedBets || []).find(s =>
    String(s?.meeting || '').trim().toLowerCase() === String(x?.meeting || '').trim().toLowerCase() &&
    String(s?.race || '').replace(/^R/i,'').trim() === String(x?.race || '').replace(/^R/i,'').trim() &&
    String(s?.selection || '').trim().toLowerCase() === String(x?.runner || '').trim().toLowerCase()
  );
  const executable = !!linkedSuggested?.executionEligible;
  const hot = absMove >= 15 || (Number.isFinite(minsToJump) && minsToJump <= 15 && absMove >= 10);
  const critical = absMove >= 25 || (Number.isFinite(minsToJump) && minsToJump <= 10 && absMove >= 20);
  const severity = executable && critical
    ? 'ACTION'
    : (critical
      ? 'CRITICAL'
      : (hot ? 'HOT' : (trackedRunner ? 'WATCH' : 'INFO')));
  const type = move < 0 ? 'hot_plunge' : 'hot_drift';
  const interpretation = move < 0
    ? (role !== 'market' ? `Market support building for ${role}` : (trackedRunner ? 'Tracked runner attracting support' : 'Market support building'))
    : (role !== 'market' ? `Market moving against ${role}` : (trackedRunner ? 'Tracked runner drifting in the market' : 'Market drifting away'));
  const action = executable
    ? (critical ? 'BET_NOW' : 'QUEUE')
    : trackedRunner
      ? (hot ? 'REVIEW_TRACKED' : 'WATCH_TRACKED')
      : role !== 'market'
        ? (move < 0 ? 'REVIEW_SIGNAL' : 'RECHECK_SIGNAL')
        : (hot ? 'WATCH_MARKET' : 'IGNORE');
  return {
    id: `${String(x?.meeting || '').toLowerCase()}|${String(x?.race || '')}|${String(x?.runner || '').toLowerCase()}|${type}`,
    ts: new Date().toISOString(),
    tenantId,
    scope: tenantId === 'default' ? 'SYSTEM' : 'TENANT',
    type,
    severity,
    title: `${severity} ${move < 0 ? 'Plunge' : 'Drift'} — ${x.meeting} R${x.race}`,
    message: `${x.runner} ${Number(x?.fromOdds).toFixed(2)} → ${Number(x?.toOdds).toFixed(2)} (${move.toFixed(1)}%)`,
    status: raceSettled ? 'settled' : 'live',
    meeting: x.meeting,
    race: String(x.race),
    selection: x.runner,
    betmanRole: role,
    trackedRunner,
    trackedPriority: trackedRunner ? 1 : 0,
    fromOdds: x.fromOdds,
    toOdds: x.toOdds,
    movePct: move,
    minsToJump: Number.isFinite(minsToJump) ? minsToJump : null,
    raceSettled,
    interpretation,
    action
  };
});

const conflictAlerts = basePulseAlerts.flatMap((a) => {
  const move = Number(a?.movePct || 0);
  const absMove = Math.abs(move);
  const role = String(a?.betmanRole || 'market');
  const conflictType = (role === 'win' && move > 0 && absMove >= 10)
    ? 'market_conflict'
    : ((role === 'odds_runner' && move < 0 && absMove >= 10)
      ? 'market_conflict'
      : ((role === 'ew' && move < 0 && absMove >= 12)
        ? 'market_conflict'
        : ''));
  if (!conflictType) return [];
  const severity = absMove >= 20 ? 'CRITICAL' : 'HOT';
  const interpretation = role === 'win'
    ? 'Market attacking BETMAN recommendation'
    : (role === 'odds_runner'
      ? 'Market confirming BETMAN odds runner'
      : 'Market validating BETMAN each-way angle');
  const action = severity === 'CRITICAL' ? 'Review race now' : 'Re-check thesis';
  return [{
    ...a,
    id: `${a.id}|conflict`,
    type: conflictType,
    severity,
    title: `${severity} Conflict — ${a.meeting} R${a.race}`,
    interpretation,
    action
  }];
});

function buildSelectionMap(rows) {
  const out = new Map();
  for (const x of (rows || [])) {
    const type = String(x?.type || '').toLowerCase();
    if (!['win','odds_runner','ew'].includes(type)) continue;
    const key = `${String(x?.meeting || '').trim().toLowerCase()}|${String(x?.race || '').replace(/^R/i,'').trim()}|${type}`;
    if (!out.has(key)) out.set(key, x);
  }
  return out;
}

const prevSelectionMap = buildSelectionMap(prevStatus?.suggestedBets || []);
const nextSelectionMap = buildSelectionMap(status.suggestedBets || []);
const selectionFlipAlerts = [];
for (const [key, nextSel] of nextSelectionMap.entries()) {
  const prevSel = prevSelectionMap.get(key);
  if (!prevSel) continue;
  const prevName = String(prevSel?.selection || '').trim();
  const nextName = String(nextSel?.selection || '').trim();
  if (!prevName || !nextName || prevName.toLowerCase() === nextName.toLowerCase()) continue;
  const [meeting, race, type] = key.split('|');
  const severity = type === 'win' ? 'CRITICAL' : 'HOT';
  selectionFlipAlerts.push({
    id: `${key}|flip|${prevName.toLowerCase()}|${nextName.toLowerCase()}`,
    ts: new Date().toISOString(),
    tenantId,
    scope: tenantId === 'default' ? 'SYSTEM' : 'TENANT',
    type: type === 'win' ? 'selection_flip_recommended' : (type === 'odds_runner' ? 'selection_flip_odds_runner' : 'selection_flip_ew'),
    severity,
    title: `${severity} Selection Flip — ${nextSel.meeting} R${nextSel.race}`,
    message: `${type.toUpperCase()} changed: ${prevName} → ${nextName}`,
    status: 'live',
    meeting: nextSel.meeting,
    race: String(nextSel.race),
    selection: nextName,
    previousSelection: prevName,
    betmanRole: type,
    minsToJump: null,
    interpretation: type === 'win' ? 'BETMAN top thesis changed' : `BETMAN ${type} angle changed`,
    action: severity === 'CRITICAL' ? 'Review immediately' : 'Re-check race'
  });
}

const jumpPulseAlerts = trackedBets
  .filter(row => String(row?.status || 'active').toLowerCase() !== 'settled')
  .map((row) => {
    const key = `${String(row?.meeting || '').trim().toLowerCase()}|${String(row?.race || '').replace(/^R/i,'').trim()}|${String(row?.selection || '').trim().toLowerCase()}`;
    const mover = (status.marketMovers || []).find(x => `${String(x?.meeting || '').trim().toLowerCase()}|${String(x?.race || '').replace(/^R/i,'').trim()}|${String(x?.runner || '').trim().toLowerCase()}` === key);
    const minsToJump = Number(mover?.minsToJump ?? row?.minsToJump);
    if (!Number.isFinite(minsToJump) || minsToJump < 0 || minsToJump > 3) return null;
    return {
      id: `${key}|jump_pulse|${Math.round(minsToJump)}`,
      ts: new Date().toISOString(),
      tenantId,
      scope: tenantId === 'default' ? 'SYSTEM' : 'TENANT',
      type: 'jump_pulse',
      severity: 'ACTION',
      title: `ACTION Jump Pulse — ${row.meeting} R${row.race}`,
      message: `${row.selection} jumps in ${Math.round(minsToJump)}m`,
      status: 'live',
      meeting: row.meeting,
      race: String(row.race),
      selection: row.selection,
      trackedRunner: true,
      trackedPriority: 2,
      betmanRole: String(row?.betType || 'tracked').toLowerCase(),
      minsToJump: Math.round(minsToJump),
      interpretation: 'Tracked runner is approaching jump time',
      action: 'REVIEW_TRACKED'
    };
  })
  .filter(Boolean);

const pulseAlertsAll = filterPulseAlerts([...basePulseAlerts, ...conflictAlerts, ...selectionFlipAlerts, ...jumpPulseAlerts], pulseConfig).sort((a,b) => {
  const sev = { ACTION: 4, CRITICAL: 3, HOT: 2, WATCH: 1, INFO: 0 };
  if (sev[b.severity] !== sev[a.severity]) return sev[b.severity] - sev[a.severity];
  const trackedDelta = Number(b?.trackedPriority || (b?.trackedRunner ? 1 : 0)) - Number(a?.trackedPriority || (a?.trackedRunner ? 1 : 0));
  if (trackedDelta !== 0) return trackedDelta;
  return Math.abs(Number(b.movePct || 0)) - Math.abs(Number(a.movePct || 0));
}).filter(a => ['ACTION','CRITICAL','HOT'].includes(String(a.severity || '')));

const pulseAlerts = pulseAlertsAll
  .filter(a => String(a?.status || 'live').toLowerCase() !== 'settled')
  .slice(0, 24);

const alertsFeedPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'alerts_feed.json') : path.join(tenantDataDir, 'alerts_feed.json');
const alertsHistoryPath = isDefaultTenant ? path.join(ROOT, 'frontend', 'data', 'alerts_history.json') : path.join(tenantDataDir, 'alerts_history.json');
const priorAlerts = loadJson(alertsHistoryPath, []);
const mergedAlerts = Array.from(new Map(
  [...pulseAlertsAll, ...filterPulseAlerts(Array.isArray(priorAlerts) ? priorAlerts : [], pulseConfig)]
    .map(alert => [String(alert?.id || `${alert?.meeting || ''}|${alert?.race || ''}|${alert?.selection || ''}|${alert?.type || ''}`), alert])
).values())
  .sort((a, b) => String(b?.ts || '').localeCompare(String(a?.ts || '')))
  .slice(0, 200);
fs.writeFileSync(alertsFeedPath, JSON.stringify({ updatedAt: new Date().toISOString(), alerts: pulseAlerts }, null, 2));
fs.writeFileSync(alertsHistoryPath, JSON.stringify(mergedAlerts, null, 2));

const CONFIDENCE_SIGNAL_THRESHOLD = 40;
const CONFIDENCE_FRINGE_BAND = 5;
const fringeSignals = (status.suggestedBets || [])
  .map(x => ({
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    type: x.type,
    odds: x.odds ?? null,
    place_odds: x.place_odds ?? null,
    jumpsIn: x.jumpsIn,
    interesting: !!x.interesting,
    reason: x.reason,
    signalPct: inferSignalPct(x)
  }))
  .filter(x => Number.isFinite(x.signalPct))
  .filter(x => Math.abs(x.signalPct - CONFIDENCE_SIGNAL_THRESHOLD) <= CONFIDENCE_FRINGE_BAND)
  .map(x => ({
    ...x,
    threshold: CONFIDENCE_SIGNAL_THRESHOLD,
    deltaFromThreshold: Math.round((x.signalPct - CONFIDENCE_SIGNAL_THRESHOLD) * 10) / 10,
    fringeBucket: x.signalPct >= CONFIDENCE_SIGNAL_THRESHOLD ? 'above-threshold' : 'below-threshold'
  }));

appendJsonl(betPlanAuditPath, {
  ts: new Date().toISOString(),
  date: state.date || null,
  suggestedCount: (status.suggestedBets || []).length,
  interestingCount: (status.interestingRunners || []).length,
  moversCount: (status.marketMovers || []).length,
  windowMins: Number(stakeData.earlyWindowMin || 180),
  suggestedTop: (status.suggestedBets || []).slice(0, 12).map(x => ({
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    type: x.type,
    odds: x.odds ?? null,
    place_odds: x.place_odds ?? null,
    jumpsIn: x.jumpsIn,
    interesting: !!x.interesting,
    reason: x.reason,
    tags: Array.isArray(x.tags) ? x.tags : [],
    pedigreeTag: x.pedigreeTag || null,
    pedigreeScore: x.pedigreeScore ?? null,
    pedigreeConfidence: x.pedigreeConfidence ?? null,
    pedigreeRelativeEdge: x.pedigreeRelativeEdge ?? null,
    pedigreeArchetype: x.pedigreeArchetype || null
  })),
  suggestedAll: (status.suggestedBets || []).map(x => ({
    meeting: x.meeting,
    race: x.race,
    selection: x.selection,
    type: x.type,
    odds: x.odds ?? null,
    place_odds: x.place_odds ?? null,
    jumpsIn: x.jumpsIn,
    interesting: !!x.interesting,
    reason: x.reason,
    tags: Array.isArray(x.tags) ? x.tags : [],
    pedigreeTag: x.pedigreeTag || null,
    pedigreeScore: x.pedigreeScore ?? null,
    pedigreeConfidence: x.pedigreeConfidence ?? null,
    pedigreeRelativeEdge: x.pedigreeRelativeEdge ?? null,
    pedigreeArchetype: x.pedigreeArchetype || null
  })),
  interestingTop: (status.interestingRunners || []).slice(0, 12),
  moversTop: (status.marketMovers || []).slice(0, 12),
  confidenceSignalThreshold: CONFIDENCE_SIGNAL_THRESHOLD,
  confidenceFringeBand: CONFIDENCE_FRINGE_BAND,
  fringeSignalCount: fringeSignals.length,
  fringeSignals
});

fs.mkdirSync(path.dirname(statusPath), { recursive: true });
fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
if (isDefaultTenant) {
  try {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'status.json'), JSON.stringify(status, null, 2));
  } catch {}
}
console.log(`status.json updated (${tenantId})`);

if (process.env.DATABASE_URL || process.env.BETMAN_DATABASE_URL) {
  const { spawnSync } = require('child_process');
  spawnSync('node', [path.join(ROOT, 'scripts', 'db_sync.js'), `--tenant=${tenantId}`, '--keys=status.json', '--audit=tail', '--auditTail=1'], { stdio: 'ignore' });
}
