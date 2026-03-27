#!/usr/bin/env node
/* TAB affiliates racing poller — pulls open races, tracks odds diffs, writes state */
const fs = require('fs');
const path = require('path');
const { runnerPedigreeSignal, computeRacePedigreeAdvantageMap, pedigreeAdjFactor } = require('./pedigree_advantage');

const BASE = 'https://api.tab.co.nz/affiliates/v1';
const RUNNER_HISTORY_CACHE_PATH = path.join(process.cwd(), 'memory', 'runner-history-cache.json');
const RUNNER_HISTORY_MAX_DAYS = parseInt(process.env.BETMAN_RUNNER_HISTORY_DAYS || '120', 10);
const RUNNER_HISTORY_SPELL_DAYS = parseInt(process.env.BETMAN_RUNNER_SPELL_DAYS || '60', 10);

function getArg(name, def) {
  const idx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (idx === -1) return def;
  return process.argv[idx].split('=').slice(1).join('=') || def;
}

function todayNZ() {
  const d = new Date();
  // NZ time; use Intl if available
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}

async function fetchJson(url, opts = {}) {
  const retries = Number.isFinite(Number(opts.retries)) ? Number(opts.retries) : 3;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 12000;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'openclaw-tab-poller/1.0' },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${url}`);
        // Retry 429/5xx and transient gateway failures.
        if (res.status === 429 || res.status >= 500) {
          lastErr = e;
        } else {
          throw e;
        }
      } else {
        return res.json();
      }
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
    }

    if (attempt < retries) {
      const backoff = 250 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  throw new Error(`fetch_failed ${url} :: ${lastErr?.message || 'unknown'}`);
}

function safeSlug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || '_';
}

function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeStatObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const starts = Number(obj.number_of_starts ?? obj.starts ?? 0);
  const wins = Number(obj.number_of_wins ?? obj.wins ?? 0);
  const seconds = Number(obj.number_of_seconds ?? obj.seconds ?? 0);
  const thirds = Number(obj.number_of_thirds ?? obj.thirds ?? 0);
  const placings = Number(obj.number_of_placings ?? obj.placings ?? (wins + seconds + thirds));
  return {
    number_of_starts: starts,
    number_of_wins: wins,
    number_of_seconds: seconds,
    number_of_thirds: thirds,
    number_of_placings: placings,
    winning_distance: obj.winning_distance ?? null
  };
}

function statsFromLastTwenty(lastTwenty) {
  if (!lastTwenty) return null;
  const chars = String(lastTwenty).split('').filter(c => /[0-9]/.test(c));
  if (!chars.length) return null;
  let wins = 0, seconds = 0, thirds = 0;
  for (const c of chars) {
    if (c === '1') wins += 1;
    else if (c === '2') seconds += 1;
    else if (c === '3') thirds += 1;
  }
  return {
    number_of_starts: chars.length,
    number_of_wins: wins,
    number_of_seconds: seconds,
    number_of_thirds: thirds,
    number_of_placings: wins + seconds + thirds,
    winning_distance: null
  };
}

function statsFromUpHistory(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const first = { number_of_starts: 0, number_of_wins: 0, number_of_seconds: 0, number_of_thirds: 0, number_of_placings: 0, winning_distance: null };
  const second = { number_of_starts: 0, number_of_wins: 0, number_of_seconds: 0, number_of_thirds: 0, number_of_placings: 0, winning_distance: null };
  for (const raw of history) {
    const line = String(raw || '').toLowerCase();
    const match = line.match(/(\d+)(st|nd|rd|th)\s+up/);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (num === 1) first.number_of_starts += 1;
    if (num === 2) second.number_of_starts += 1;
  }
  return {
    first_up: first.number_of_starts ? first : null,
    second_up: second.number_of_starts ? second : null
  };
}

function backfillRunnerStats(stats, runner, race) {
  if (!stats || typeof stats !== 'object') return stats;
  if (!stats.overall) {
    const derivedOverall = statsFromLastTwenty(runner.last_twenty_starts);
    if (derivedOverall) stats.overall = derivedOverall;
  }
  if (!stats.first_up || !stats.second_up) {
    const derivedUp = statsFromUpHistory(runner.runner_win_history);
    if (!stats.first_up && derivedUp?.first_up) stats.first_up = derivedUp.first_up;
    if (!stats.second_up && derivedUp?.second_up) stats.second_up = derivedUp.second_up;
  }
  const overall = normalizeStatObject(stats.overall);
  if (overall) stats.overall = overall;
  if (overall && !stats.track) stats.track = { ...overall };
  if (overall && !stats.distance) stats.distance = { ...overall };
  if (overall && !stats.first_up) stats.first_up = { ...overall };
  if (overall && !stats.second_up) stats.second_up = { ...overall };
  if (overall && !stats.soft) stats.soft = { ...overall };
  if (overall && !stats.heavy) stats.heavy = { ...overall };
  if (overall && !stats.good) stats.good = { ...overall };
  return stats;
}

function extractRunnerRow(r, race) {
  const weight = r.weight || {};
  const pickStats = (fields = []) => {
    const out = {};
    fields.forEach(field => {
      if (r[field] && typeof r[field] === 'object') out[field] = r[field];
    });
    return out;
  };
  let stats = pickStats([
    'overall','track','distance','track_distance','good','soft','heavy','slow','firm','synthetic','turf','left_handed','right_handed',
    'first_up','second_up','third_up','fourth_up','fresh_30','fresh_90'
  ]);
  stats = backfillRunnerStats(stats, r, race);

  return {
    event_id: race.event_id,
    meeting: race.meeting_name,
    race_number: race.race_number,
    race_name: race.description,
    race_status: race.status,
    start_time_nz: race.start_time_nz,
    track_condition: race.track_condition,
    distance: race.distance,
    runner_number: r.runner_number,
    runner_name: r.name,
    barrier: r.barrier,
    jockey: r.jockey,
    trainer: r.trainer_name,
    trainer_location: r.trainer_location || null,
    owners: Array.isArray(r.owners) ? r.owners.join(', ') : (r.owners || null),
    gear: r.gear || null,
    age: r.age || null,
    sex: r.sex || null,
    colour: r.colour || null,
    country: r.country || null,
    favourite: !!r.favourite,
    mover: r.mover || null,
    form_comment: r.form_comment || null,
    form_indicators: r.form_indicators || null,
    allowance_weight: r.allowance_weight || null,
    apprentice_indicator: r.apprentice_indicator || null,
    weight_allocated: weight.allocated,
    weight_total: weight.total,
    rating: r.rating ?? null,
    handicap_rating: r.handicap_rating ?? null,
    win_p: r.win_p ?? null,
    place_p: r.place_p ?? null,
    spr: r.spr ?? null,
    fixed_win: r.odds?.fixed_win ?? null,
    fixed_place: r.odds?.fixed_place ?? null,
    tote_win: r.odds?.pool_win ?? null,
    tote_place: r.odds?.pool_place ?? null,
    is_scratched: r.is_scratched,
    last_twenty_starts: r.last_twenty_starts,
    last_starts: r.last_starts || null,
    sire: r.sire,
    dam: r.dam,
    dam_sire: r.dam_sire,
    dam_dam: r.dam_dam || null,
    breeding: r.breeding || null,
    speedmap: r.speedmap?.label ?? null,
    silk_url_64x64: r.silk_url_64x64 || r.silk_url || r.alt_silk_url_64x64 || null,
    silk_url_128x128: r.silk_url_128x128 || r.alt_silk_url_128x128 || null,
    silk_colours: r.silk_colours || null,
    ride_guide_exists: !!r.ride_guide_exists,
    ride_guide_thumbnail: r.ride_guide_thumbnail || null,
    ride_guide_file: r.ride_guide_file || null,
    stats,
  };
}

function recentFormOK(lastTwenty, windowN, top3Min) {
  if (!lastTwenty) return false;
  const chars = String(lastTwenty).split('').filter(c => c !== 'x' && c !== 'X' && /[0-9]/.test(c));
  const recent = chars.slice(-windowN);
  if (recent.length < windowN) return false;
  let top3 = 0;
  for (const c of recent) {
    const n = parseInt(c, 10);
    if (n >= 1 && n <= 3) top3++;
  }
  return top3 >= top3Min;
}

function adjFactor(r, profileBias=null) {
  let adj = 0;
  const inds = (r.form_indicators || '').split(';').map(s => s.trim()).filter(Boolean);
  const pos = (name, delta) => { if (inds.includes(name)) adj += delta; };
  pos('Jockey Flying', 0.02);
  pos('Jockey Airborne', 0.015);
  pos('Trainer / Jockey Combo', 0.01);
  pos('Jockey / Horse Combo', 0.01);
  pos('Unbeaten Jockey / Horse Combo', 0.015);
  pos('Form on Good', 0.01);
  pos('Strong Form on Good', 0.01);
  pos('Unbeaten the Track', 0.01);
  // barrier
  if (r.barrier && r.barrier <= 4) adj += 0.01;
  if (r.barrier && r.barrier >= 10) adj -= 0.01;
  // speedmap baseline
  if (['Leader','Pace'].includes(r.speedmap)) adj += 0.008;

  // meeting bias overlay (from rolling profile)
  if (profileBias) {
    if (profileBias.pace_leader && ['Leader','Pace'].includes(r.speedmap)) adj += profileBias.pace_leader;
    if (profileBias.backmarker && ['Backmarker','Off Pace','Off Midfield'].includes(r.speedmap)) adj += profileBias.backmarker;
    if (profileBias.low_barrier && r.barrier && r.barrier <= 4) adj += profileBias.low_barrier;
    if (profileBias.high_barrier && r.barrier && r.barrier >= 10) adj += profileBias.high_barrier;
  }

  return adj;
}

function bestWinOdds(r){
  const f = Number(r?.fixed_win || 0);
  if (Number.isFinite(f) && f > 0) return f;
  const t = Number(r?.tote_win || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return NaN;
}


const BANNED_MEETING_REGEX = /(greyhound|grey hound|dogs|dog racing|dog track|hound|harness|trots?)/i;
const ALLOWED_GALLOPS_CODES = new Set(['T','TBRED','THOROUGHBRED','R']);
const BANNED_GALLOPS_CODES = new Set(['G','GREYHOUND','H','HARNESS','D','DOGS','TR','TROT','HR']);

function interpretGallopsCode(value){
  const code = String(value || '').trim().toUpperCase();
  if (!code) return null;
  if (BANNED_GALLOPS_CODES.has(code)) return false;
  if (ALLOWED_GALLOPS_CODES.has(code)) return true;
  return null;
}

function isGallopsMeeting(mtg){
  const fields = [mtg?.category, mtg?.classification, mtg?.meeting_type, mtg?.race_type, mtg?.sport, mtg?.sportType, mtg?.sports_code];
  for (const f of fields) {
    const flag = interpretGallopsCode(f);
    if (flag === false) return false;
    if (flag === true) return true;
  }
  const name = `${mtg?.name || ''} ${mtg?.display_name || ''}`.toLowerCase();
  if (BANNED_MEETING_REGEX.test(name)) return false;
  return true;
}

function isGallopsRace(race){
  const fields = [race?.type, race?.classification, race?.category, race?.program_type, race?.race_type];
  for (const f of fields) {
    const flag = interpretGallopsCode(f);
    if (flag === false) return false;
    if (flag === true) return true;
  }
  const label = `${race?.description || ''}`.toLowerCase();
  if (BANNED_MEETING_REGEX.test(label)) return false;
  return true;
}
function bestPlaceOdds(r){
  const f = Number(r?.fixed_place || 0);
  if (Number.isFinite(f) && f > 0) return f;
  const t = Number(r?.tote_place || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return NaN;
}

const probCalibration = loadJson(path.join(process.cwd(), 'memory', 'betman_prob_calibration.json'), null);
const applyCalibration = (p) => {
  if (!probCalibration || !Array.isArray(probCalibration.bins)) return p;
  const bin = probCalibration.bins.find(b => typeof b.min === 'number' && typeof b.max === 'number' && p >= b.min && p < b.max);
  if (!bin || !Number.isFinite(bin.multiplier)) return p;
  const samples = Number(bin.samples || 0);
  const sampleConfidence = Math.max(0, Math.min(1, samples / 250));
  const safeMultiplier = 1 + ((Math.max(0.75, Math.min(1.25, bin.multiplier)) - 1) * sampleConfidence);
  return p * safeMultiplier;
};

function computeAdjProbs(runners, profileBias=null, pedigreeMap=null) {
  const base = [];
  for (const r of runners) {
    const winOdds = bestWinOdds(r);
    if (!Number.isFinite(winOdds) || winOdds <= 0) continue;
    base.push({ r, p: 1 / winOdds });
  }
  const sum = base.reduce((a,b)=>a+b.p,0) || 1;
  let adj = base.map(x => ({ r: x.r, p: (x.p / sum) * (1 + adjFactor(x.r, profileBias) + pedigreeAdjFactor(x.r, pedigreeMap)) }));
  let asum = adj.reduce((a,b)=>a+b.p,0) || 1;
  adj = adj.map(x => ({ r: x.r, p: x.p / asum }));
  if (probCalibration && Array.isArray(probCalibration.bins)) {
    adj = adj.map(x => ({ r: x.r, p: applyCalibration(x.p) }));
    asum = adj.reduce((a,b)=>a+b.p,0) || 1;
    adj = adj.map(x => ({ r: x.r, p: x.p / asum }));
  }
  adj.sort((a,b)=>b.p - a.p);
  return adj;
}

async function main() {
  const date = getArg('date', todayNZ());
  const countries = (getArg('countries', 'NZ,AUS,HK')).split(',').map(s => s.trim()).filter(Boolean);
  const meetingsFilter = (getArg('meetings', '')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const statusFilter = getArg('status', '');
  const moveThreshold = parseFloat(getArg('move', '0.1')); // 10% default
  const stakeCfg = loadJson(path.join(process.cwd(), 'frontend', 'data', 'stake.json'), { stakePerRace: 10, exoticStakePerRace: 1, betHarderMultiplier: 1.5 });
  const longOdds = parseFloat(getArg('long_odds', '12'));
  const recentWindow = parseInt(getArg('recent_window', '3'), 10);
  const recentTop3 = parseInt(getArg('recent_top3', '2'), 10);
  const stakePerRace = parseFloat(getArg('stake_per_race', String(stakeCfg.stakePerRace || 10)));
  const exoticStakePerRace = parseFloat(getArg('exotic_stake_per_race', String(stakeCfg.exoticStakePerRace || 1)));
  const betHarderMultiplier = parseFloat(getArg('bet_harder_multiplier', String(stakeCfg.betHarderMultiplier || 1.5)));
  const minEdge = parseFloat(getArg('min_edge', String(stakeCfg.minEdge ?? 0.04)));
  const strongEdge = parseFloat(getArg('strong_edge', '0.06'));
  const minConfidence = parseFloat(getArg('min_confidence', '58'));
  const strongConfidence = parseFloat(getArg('strong_confidence', '65'));
  const standoutProb = parseFloat(getArg('standout_prob', '0.35'));
  const standoutRatio = parseFloat(getArg('standout_ratio', '1.8'));
  const splitTop1 = parseFloat(getArg('split_top1', '0.6')); // remainder to 2nd pick
  const ewWinMin = parseFloat(getArg('ew_win_min', '6'));
  const ewPlaceMin = parseFloat(getArg('ew_place_min', '2'));
  const earlyWindowMin = parseFloat(getArg('early_window_min', '180'));
  const aiWindowMin = parseFloat(getArg('ai_window_min', '10'));

  const outBase = path.join(process.cwd(), 'data', 'tab', date);
  const statePath = path.join(process.cwd(), 'memory', 'racing-poll-state.json');
  const prev = loadJson(statePath, { ts: null, races: {} });
  const profilesDir = path.join(process.cwd(), 'data', 'meeting_profiles', date);

  const summary = { ts: new Date().toISOString(), date, races: {}, bet_plans: [], early_plans: [], candidates: [], exotic_plans: [] };
  const moves = [];
  const candidates = [];
  const betPlans = [];
  const earlyPlans = [];
  const exoticPlans = [];

  const failedCountries = new Set();

  function blockedSignalBucket({ prob, edge, odds, confidence, formStatus='UNKNOWN', trackLabel='NEUTRAL' }) {
    const probPct = Number.isFinite(prob) ? prob * 100 : NaN;
    const edgePts = Number.isFinite(edge) ? edge * 100 : NaN;
    if (formStatus === 'COLD') return 'blocked:cold_form';
    if (trackLabel === 'DISLIKES THIS GROUND') return 'blocked:track_dislike';
    if (Number.isFinite(confidence) && confidence < 50) return 'blocked:confidence_below_50';
    if (Number.isFinite(edgePts) && edgePts < 2) return 'blocked:edge_below_2pts';
    if (Number.isFinite(edgePts) && edgePts < 4 && Number.isFinite(odds) && odds >= 5 && odds < 8) return 'blocked:edge_2_4_odds_5_8';
    if (Number.isFinite(probPct) && probPct >= 20 && probPct < 25) {
      if (!(Number.isFinite(confidence) && confidence >= strongConfidence && Number.isFinite(edgePts) && edgePts >= 6 && ['HOT','SOLID'].includes(formStatus) && ['LOVES THIS GROUND','SUITED','NEUTRAL'].includes(trackLabel))) {
        return 'blocked:toxic_20_25_band';
      }
    }
    return null;
  }

  for (const country of countries) {
    async function fetchMeetingsForDate(d){
      const qs = new URLSearchParams({ date_from: d, date_to: d, country, type: 'T', limit: '200', offset: '0' });
      return fetchJson(`${BASE}/racing/meetings?${qs}`);
    }

    let meetingsDate = date;
    let meetings = null;
    let list = [];
    try {
      meetings = await fetchMeetingsForDate(meetingsDate);
      list = (meetings.data && meetings.data.meetings) || [];
    } catch (e) {
      console.error(`Meetings fetch failed for ${country} ${meetingsDate}: ${e.message}`);
      failedCountries.add(country);
      continue;
    }

    // HK midnight rollover: if no meetings on "today", try previous NZ date.
    if (!list.length && country === 'HK') {
      const prev = new Date(`${date}T00:00:00`);
      if (!isNaN(prev)) {
        prev.setDate(prev.getDate() - 1);
        const prevDate = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}-${String(prev.getDate()).padStart(2,'0')}`;
        try {
          const alt = await fetchMeetingsForDate(prevDate);
          const altList = (alt.data && alt.data.meetings) || [];
          if (altList.length) {
            meetingsDate = prevDate;
            meetings = alt;
            list = altList;
          }
        } catch {}
      }
    }

    for (const mtg of list) {
      if (!isGallopsMeeting(mtg)) continue; // gallops only
      if (meetingsFilter.length && !meetingsFilter.includes((mtg.name || '').toLowerCase())) continue;

      for (const race of (mtg.races || [])) {
        if (!isGallopsRace(race)) continue; // gallops only
        if (statusFilter && race.status !== statusFilter) continue;
        if (!race.id) continue;

        let evt;
        try {
          evt = await fetchJson(`${BASE}/racing/events/${race.id}`);
        } catch (e) {
          console.error(`Event fetch failed ${country}:${mtg.name}:R${race.race_number} (${race.id}): ${e.message}`);
          continue;
        }
        const r = evt.data?.race || {};
        const runners = (evt.data?.runners || []).filter(x => !x.is_scratched);

        const raceKey = `${country}:${mtg.name}:R${race.race_number}`;
        summary.races[raceKey] = {
          event_id: r.event_id,
          meeting: r.meeting_name,
          race_number: r.race_number,
          description: r.description,
          start_time_nz: r.start_time_nz,
          advertised_start: r.advertised_start || r.advertised_start_string || null,
          track_condition: r.track_condition,
          distance: r.distance,
          rail_position: r.rail_position,
          race_status: race.status,
          runners: runners.map(x => extractRunnerRow(x, r)),
        };

        // long-odds + good recent form candidates (only within 10 mins to start)
        let minsToStart = null;
        if (summary.races[raceKey].advertised_start) {
          const rawStart = summary.races[raceKey].advertised_start;
          // TAB can return epoch seconds; JS Date expects milliseconds.
          const startMs = (typeof rawStart === 'number' && rawStart < 1e12) ? rawStart * 1000 : rawStart;
          const start = new Date(startMs);
          if (!isNaN(start)) minsToStart = (start - new Date()) / 60000;
        }

        const inWindow = minsToStart !== null && minsToStart >= 0 && minsToStart <= aiWindowMin;
        const inEarlyWindow = minsToStart !== null && minsToStart > aiWindowMin && minsToStart <= earlyWindowMin;

        // long-odds + good recent form candidates
        if (inWindow) {
          for (const rr of summary.races[raceKey].runners) {
            const winOdds = bestWinOdds(rr);
            if (!Number.isFinite(winOdds) || winOdds <= 0) continue;
            if (winOdds < longOdds) continue;
            if (!recentFormOK(rr.last_twenty_starts, recentWindow, recentTop3)) continue;
            candidates.push({
              race: raceKey,
              runner: rr.runner_name,
              odds: winOdds,
              last: rr.last_twenty_starts,
              barrier: rr.barrier,
              jockey: rr.jockey,
              trainer: rr.trainer,
              mins_to_start: Math.round(minsToStart*10)/10,
            });
          }
        }

        // bet plan (within 10 min)
        if (inWindow || inEarlyWindow) {
          // load meeting profile bias if available
          let profileBias = null;
          try {
            const mtgSlug = safeSlug(mtg.name);
            const profPath = path.join(profilesDir, `${mtgSlug}.json`);
            const prof = loadJson(profPath, null);
            if (prof && prof.totals?.races_final) {
              const total = prof.totals.races_final;
              const paceWins = prof.winners?.pace || {};
              const barrierWins = prof.winners?.barrier || {};
              const leaderShare = ((paceWins.Leader||0)+(paceWins.Pace||0)) / total;
              const backShare = ((paceWins['Backmarker']||0)+(paceWins['Off Pace']||0)+(paceWins['Off Midfield']||0)) / total;
              const lowShare = (barrierWins.low||0) / total;
              const highShare = (barrierWins.high||0) / total;
              profileBias = {
                pace_leader: leaderShare > 0.4 ? 0.01 : 0,
                backmarker: backShare > 0.4 ? 0.01 : 0,
                low_barrier: lowShare > 0.5 ? 0.005 : 0,
                high_barrier: highShare > 0.5 ? 0.005 : 0,
              };
            }
          } catch {}

          const pedigreeMap = computeRacePedigreeAdvantageMap(summary.races[raceKey], summary.races[raceKey].runners || []);
          const adj = computeAdjProbs(summary.races[raceKey].runners, profileBias, pedigreeMap);
          if (adj.length >= 1) {
            const top1 = adj[0];
            const top2 = adj[1];
            const top3 = adj[2];
            const top4 = adj[3];
            const standout = top2 ? (top1.p >= standoutProb && top1.p >= standoutRatio * top2.p) : (top1.p >= standoutProb);
            const targetArr = inWindow ? betPlans : earlyPlans;

            // Top-2/3/4 and trifecta planning (advisory queue)
            const rank = adj.slice(0, 4).map(x => ({
              selection: x.r.runner_name,
              win_prob: Math.round(x.p * 1000) / 10,
              odds: bestWinOdds(x.r)
            }));
            if (rank.length >= 2) {
              exoticPlans.push({
                race: raceKey,
                market: 'Top2',
                mins_to_start: Math.round(minsToStart * 10) / 10,
                selections: rank.slice(0, 2),
                note: 'Top-2 profile from adjusted win probabilities'
              });
            }
            if (rank.length >= 3) {
              exoticPlans.push({
                race: raceKey,
                market: 'Top3',
                mins_to_start: Math.round(minsToStart * 10) / 10,
                selections: rank.slice(0, 3),
                note: 'Top-3 profile from adjusted win probabilities'
              });
              exoticPlans.push({
                race: raceKey,
                market: 'Trifecta',
                mins_to_start: Math.round(minsToStart * 10) / 10,
                structure: {
                  first: rank[0].selection,
                  second_third_box: [rank[1].selection, rank[2].selection]
                },
                note: 'Anchor top pick in first, box 2nd/3rd'
              });
            }
            if (rank.length >= 4) {
              exoticPlans.push({
                race: raceKey,
                market: 'Top4',
                mins_to_start: Math.round(minsToStart * 10) / 10,
                selections: rank.slice(0, 4),
                note: 'Top-4 profile from adjusted win probabilities'
              });
            }

            if (standout || !top2) {
              const odds = bestWinOdds(top1.r);
              const implied = Number.isFinite(odds) && odds > 0 ? (1 / odds) : NaN;
              const edge = Number.isFinite(implied) ? (top1.p - implied) : -1;
              if (edge >= minEdge) {
                const place = bestPlaceOdds(top1.r);
                const useEW = odds && odds >= ewWinMin && (!Number.isFinite(place) || place >= ewPlaceMin);
                const standoutStake = standout ? Math.round(stakePerRace * betHarderMultiplier * 100) / 100 : stakePerRace;
                const pedigree = pedigreeMap.get(String(top1.r.runner_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) || runnerPedigreeSignal(top1.r, summary.races[raceKey]);
                const tags = [];
                if (pedigree?.qualifies) tags.push('Pedigree Advantage');
                const confidence = Number.isFinite(pedigree?.confidence) ? (pedigree.confidence * 100) : 60;
                const pedAdj = pedigreeAdjFactor(top1.r, pedigreeMap);
                const formStatus = recentFormOK(top1.r.last_twenty_starts, recentWindow, recentTop3) ? 'SOLID' : 'MIXED';
                const blockedReason = blockedSignalBucket({ prob: top1.p, edge, odds, confidence, formStatus, trackLabel: 'NEUTRAL' });
                if (blockedReason || confidence < minConfidence || edge < (standout ? strongEdge : minEdge)) {
                  if (blockedReason) candidates.push({ race: raceKey, runner: top1.r.runner_name, odds, last: top1.r.last_twenty_starts, barrier: top1.r.barrier, jockey: top1.r.jockey, trainer: top1.r.trainer, mins_to_start: Math.round(minsToStart*10)/10, blocked_reason: blockedReason });
                } else targetArr.push({
                  race: raceKey,
                  selection: top1.r.runner_name,
                  bet_type: useEW ? 'EW' : 'Win',
                  stake: standoutStake,
                  win_prob: Math.round(top1.p*1000)/10,
                  odds,
                  place_odds: Number.isFinite(place) ? place : null,
                  edge_pct: Math.round(edge * 1000) / 10,
                  pedigreeEdgeContribution: Math.round(pedAdj * 1000) / 10,
                  mins_to_start: Math.round(minsToStart*10)/10,
                  standout: Boolean(standout),
                  tags,
                  pedigreeTag: pedigree?.qualifies ? 'Pedigree Advantage' : null,
                  pedigreeScore: Number.isFinite(pedigree?.score) ? Math.round(pedigree.score * 10) / 10 : null,
                  pedigreeConfidence: Number.isFinite(pedigree?.confidence) ? Math.round(pedigree.confidence * 1000) / 10 : null,
                  pedigreeRelativeEdge: Number.isFinite(pedigree?.relativeEdge) ? Math.round(pedigree.relativeEdge * 10) / 10 : null,
                  pedigreeArchetype: pedigree?.archetype || null
                });
              }
            } else {
              const stake1 = Math.round(stakePerRace * splitTop1 * 100) / 100;
              const stake2 = Math.round((stakePerRace - stake1) * 100) / 100;
              const odds1 = bestWinOdds(top1.r);
              const odds2 = bestWinOdds(top2.r);
              const implied1 = Number.isFinite(odds1) && odds1 > 0 ? (1 / odds1) : NaN;
              const implied2 = Number.isFinite(odds2) && odds2 > 0 ? (1 / odds2) : NaN;
              const place1 = bestPlaceOdds(top1.r);
              const place2 = bestPlaceOdds(top2.r);
              const useEW1 = odds1 && odds1 >= ewWinMin && (!Number.isFinite(place1) || place1 >= ewPlaceMin);
              const useEW2 = odds2 && odds2 >= ewWinMin && (!Number.isFinite(place2) || place2 >= ewPlaceMin);
              const edge1 = Number.isFinite(implied1) ? (top1.p - implied1) : -1;
              const edge2 = Number.isFinite(implied2) ? (top2.p - implied2) : -1;
              if (edge1 >= minEdge) {
                const pedigree = pedigreeMap.get(String(top1.r.runner_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) || runnerPedigreeSignal(top1.r, summary.races[raceKey]);
                const tags = [];
                if (pedigree?.qualifies) tags.push('Pedigree Advantage');
                const confidence1 = Number.isFinite(pedigree?.confidence) ? (pedigree.confidence * 100) : 60;
                const pedAdj1 = pedigreeAdjFactor(top1.r, pedigreeMap);
                const formStatus1 = recentFormOK(top1.r.last_twenty_starts, recentWindow, recentTop3) ? 'SOLID' : 'MIXED';
                const blockedReason1 = blockedSignalBucket({ prob: top1.p, edge: edge1, odds: odds1, confidence: confidence1, formStatus: formStatus1, trackLabel: 'NEUTRAL' });
                if (blockedReason1 || confidence1 < minConfidence || edge1 < strongEdge) {
                  if (blockedReason1) candidates.push({ race: raceKey, runner: top1.r.runner_name, odds: odds1, last: top1.r.last_twenty_starts, barrier: top1.r.barrier, jockey: top1.r.jockey, trainer: top1.r.trainer, mins_to_start: Math.round(minsToStart*10)/10, blocked_reason: blockedReason1 });
                } else targetArr.push({
                  race: raceKey,
                  selection: top1.r.runner_name,
                  bet_type: useEW1 ? 'EW' : 'Win',
                  stake: stake1,
                  win_prob: Math.round(top1.p*1000)/10,
                  odds: odds1,
                  place_odds: Number.isFinite(place1) ? place1 : null,
                  edge_pct: Math.round(edge1 * 1000) / 10,
                  pedigreeEdgeContribution: Math.round(pedAdj1 * 1000) / 10,
                  mins_to_start: Math.round(minsToStart*10)/10,
                  tags,
                  pedigreeTag: pedigree?.qualifies ? 'Pedigree Advantage' : null,
                  pedigreeScore: Number.isFinite(pedigree?.score) ? Math.round(pedigree.score * 10) / 10 : null,
                  pedigreeConfidence: Number.isFinite(pedigree?.confidence) ? Math.round(pedigree.confidence * 1000) / 10 : null,
                  pedigreeRelativeEdge: Number.isFinite(pedigree?.relativeEdge) ? Math.round(pedigree.relativeEdge * 10) / 10 : null,
                  pedigreeArchetype: pedigree?.archetype || null
                });
              }
              if (edge2 >= minEdge) {
                const pedigree = pedigreeMap.get(String(top2.r.runner_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) || runnerPedigreeSignal(top2.r, summary.races[raceKey]);
                const tags = [];
                if (pedigree?.qualifies) tags.push('Pedigree Advantage');
                const confidence2 = Number.isFinite(pedigree?.confidence) ? (pedigree.confidence * 100) : 60;
                const pedAdj2 = pedigreeAdjFactor(top2.r, pedigreeMap);
                const formStatus2 = recentFormOK(top2.r.last_twenty_starts, recentWindow, recentTop3) ? 'SOLID' : 'MIXED';
                const blockedReason2 = blockedSignalBucket({ prob: top2.p, edge: edge2, odds: odds2, confidence: confidence2, formStatus: formStatus2, trackLabel: 'NEUTRAL' });
                if (blockedReason2 || confidence2 < minConfidence || edge2 < strongEdge) {
                  if (blockedReason2) candidates.push({ race: raceKey, runner: top2.r.runner_name, odds: odds2, last: top2.r.last_twenty_starts, barrier: top2.r.barrier, jockey: top2.r.jockey, trainer: top2.r.trainer, mins_to_start: Math.round(minsToStart*10)/10, blocked_reason: blockedReason2 });
                } else targetArr.push({
                  race: raceKey,
                  selection: top2.r.runner_name,
                  bet_type: useEW2 ? 'EW' : 'Win',
                  stake: stake2,
                  win_prob: Math.round(top2.p*1000)/10,
                  odds: odds2,
                  place_odds: Number.isFinite(place2) ? place2 : null,
                  edge_pct: Math.round(edge2 * 1000) / 10,
                  pedigreeEdgeContribution: Math.round(pedAdj2 * 1000) / 10,
                  mins_to_start: Math.round(minsToStart*10)/10,
                  tags,
                  pedigreeTag: pedigree?.qualifies ? 'Pedigree Advantage' : null,
                  pedigreeScore: Number.isFinite(pedigree?.score) ? Math.round(pedigree.score * 10) / 10 : null,
                  pedigreeConfidence: Number.isFinite(pedigree?.confidence) ? Math.round(pedigree.confidence * 1000) / 10 : null,
                  pedigreeRelativeEdge: Number.isFinite(pedigree?.relativeEdge) ? Math.round(pedigree.relativeEdge * 10) / 10 : null,
                  pedigreeArchetype: pedigree?.archetype || null
                });
              }
            }
          }
        }

        // persist raw + csv
        const mtgSlug = safeSlug(mtg.name);
        const raceDir = path.join(outBase, country, mtgSlug, `R${String(race.race_number).padStart(2,'0')}-${race.id}`);
        fs.mkdirSync(raceDir, { recursive: true });
        fs.writeFileSync(path.join(raceDir, 'event.json'), JSON.stringify(evt, null, 2));

        // diff odds
        const prevRace = prev.races?.[raceKey];
        if (prevRace) {
          const prevOdds = Object.fromEntries((prevRace.runners || []).map(x => [x.runner_name, bestWinOdds(x)]));
          for (const rr of summary.races[raceKey].runners) {
            const nowOdds = bestWinOdds(rr);
            if (!Number.isFinite(nowOdds) || !prevOdds[rr.runner_name]) continue;
            const old = prevOdds[rr.runner_name];
            const now = nowOdds;
            const change = (now - old) / old;
            if (Math.abs(change) >= moveThreshold) {
              moves.push({ race: raceKey, runner: rr.runner_name, old, now, change });
            }
          }
        }
      }
    }
  }

  // Allocate a fixed exotic budget per race across generated exotic markets.
  const groupedExotics = exoticPlans.reduce((acc, x) => {
    (acc[x.race] ||= []).push(x);
    return acc;
  }, {});
  for (const race of Object.keys(groupedExotics)) {
    const arr = groupedExotics[race];
    const per = arr.length ? Math.round((exoticStakePerRace / arr.length) * 100) / 100 : 0;
    arr.forEach((x, i) => {
      x.stake = per;
      if (i === arr.length - 1) {
        // rounding fix to keep race total exact
        const used = Math.round(per * (arr.length - 1) * 100) / 100;
        x.stake = Math.round((exoticStakePerRace - used) * 100) / 100;
      }
    });
  }

  // Preserve last-known-good races when a country fetch fails, to avoid UI/race cache collapse.
  if (failedCountries.size) {
    for (const [k, r] of Object.entries(prev.races || {})) {
      const c = String(k || '').split(':')[0];
      if (!failedCountries.has(c)) continue;
      if (!summary.races[k]) summary.races[k] = r;
    }
  }

  summary.bet_plans = betPlans;
  summary.early_plans = earlyPlans;
  summary.candidates = candidates;
  summary.exotic_plans = exoticPlans;
  writeJson(statePath, summary);

  // Output concise summary
  const raceKeys = Object.keys(summary.races);
  console.log(`Racing poll complete: ${raceKeys.length} open races (date ${date}).`);
  if (moves.length) {
    console.log('Odds moves (>= ' + Math.round(moveThreshold*100) + '%):');
    for (const m of moves.slice(0, 20)) {
      const dir = m.change > 0 ? 'drift' : 'firm';
      console.log(`- ${m.race} | ${m.runner}: ${m.old} -> ${m.now} (${dir} ${Math.round(Math.abs(m.change)*100)}%)`);
    }
  } else {
    console.log('No significant odds moves vs last poll.');
  }

  if (candidates.length) {
    console.log(`Long-odds + good-form candidates (odds >= ${longOdds}, last ${recentWindow} with >=${recentTop3} top-3s):`);
    for (const c of candidates.slice(0, 20)) {
      console.log(`- ${c.race} | ${c.runner} @ ${c.odds} | last=${c.last} | barrier=${c.barrier} | jockey=${c.jockey} | t-${c.mins_to_start}m`);
    }
  } else {
    console.log('No long-odds + good-form candidates found.');
  }

  if (betPlans.length) {
    console.log('Bet plans (within 10 min):');
    for (const b of betPlans.slice(0, 20)) {
      const extra = b.bet_type === 'EW' ? ` (place ${b.place_odds})` : '';
      console.log(`- ${b.race} | ${b.selection} | ${b.bet_type} $${b.stake} | p=${b.win_prob}% | odds=${b.odds}${extra} | t-${b.mins_to_start}m`);
    }
  } else {
    console.log(`No bet plans in the ${Math.round(aiWindowMin)}-minute window.`);
  }

  if (earlyPlans.length) {
    console.log(`Early queue plans (${Math.round(aiWindowMin)+1}-${Math.round(earlyWindowMin)} min):`);
    for (const b of earlyPlans.slice(0, 20)) {
      console.log(`- ${b.race} | ${b.selection} | ${b.bet_type} $${b.stake} | p=${b.win_prob}% | odds=${b.odds} | t-${b.mins_to_start}m`);
    }
  } else {
    console.log('No early queue plans in the configured window.');
  }

  if (exoticPlans.length) {
    console.log('Exotic/top profile plans:');
    for (const x of exoticPlans.slice(0, 20)) {
      if (x.selections) {
        console.log(`- ${x.race} | ${x.market} | $${x.stake} | ${x.selections.map(s => `${s.selection}(${s.win_prob}%)`).join(' / ')} | t-${x.mins_to_start}m`);
      } else if (x.structure) {
        console.log(`- ${x.race} | ${x.market} | $${x.stake} | 1st ${x.structure.first} / 2nd-3rd box ${x.structure.second_third_box.join(', ')} | t-${x.mins_to_start}m`);
      }
    }
  } else {
    console.log('No exotic/top profile plans in current window.');
  }
}

main().catch(err => {
  console.error('Poller error:', err);
  process.exit(1);
});
