#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

function hasCredentials(settings = {}) {
  return Boolean(settings.username && settings.password);
}

function aiGoNoGo(order = {}, settings = {}) {
  const minSignal = Number(settings.minSignalPct || 40);
  const minRouteConf = Number(settings.minRouteConfidence || 55);
  const signal = Number(order.signalPct || 0);
  const routeConf = Number(order.executionRouteConfidence || 0);
  const route = String(order.executionRoute || 'NO_EDGE').toUpperCase();

  const reasons = [];
  if (!hasCredentials(settings)) reasons.push('missing_credentials');
  if (!['TAB', 'BOTH', 'BETCHA'].includes(String(settings.platform || 'TAB').toUpperCase())) reasons.push('platform_not_supported');
  if (route === 'NO_EDGE') reasons.push('no_edge_route');
  if (signal < minSignal) reasons.push('signal_below_threshold');
  if (routeConf < minRouteConf) reasons.push('route_confidence_below_threshold');

  if (reasons.length) return { decision: 'NO_GO', reasons };
  return { decision: 'GO', reasons: ['all_checks_passed'] };
}

function placeTabBet(order = {}, settings = {}) {
  const preflight = aiGoNoGo(order, settings);
  if (preflight.decision !== 'GO') {
    return {
      ok: false,
      status: 'rejected',
      stage: 'preflight',
      decision: preflight.decision,
      reasons: preflight.reasons,
      bookmakerRef: { ticketId: null, reason: preflight.reasons.join(', ') }
    };
  }

  if (String(process.env.AUTOBET_TAB_LIVE || 'false').toLowerCase() !== 'true') {
    return {
      ok: false,
      status: 'blocked',
      stage: 'adapter',
      decision: 'NO_GO_REVIEW',
      reasons: ['AUTOBET_TAB_LIVE_not_enabled'],
      bookmakerRef: { ticketId: null, reason: 'AUTOBET_TAB_LIVE_not_enabled' }
    };
  }

  // Controlled test mode: exercise full execution lifecycle without real TAB submit.
  if (String(process.env.AUTOBET_TAB_TEST_MODE || 'false').toLowerCase() === 'true') {
    const ticketId = `TAB-TEST-${Date.now()}`;
    return {
      ok: true,
      status: 'submitted',
      stage: 'tab_submit_test',
      decision: 'GO',
      reasons: ['tab_submit_test_mode'],
      bookmakerRef: { ticketId, reason: 'test_mode_simulated_submit' }
    };
  }

  // Real submit worker: attempts TAB login + slip + stake + submit.
  const worker = spawnSync('node', [path.join(__dirname, 'tab_submit_worker.js'), JSON.stringify({ order, settings })], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env }
  });
  if (worker.error) {
    return {
      ok: false,
      status: 'blocked',
      stage: 'tab_submit',
      decision: 'NO_GO_REVIEW',
      reasons: [String(worker.error.message || 'tab_submit_worker_error')],
      bookmakerRef: { ticketId: null, reason: String(worker.error.message || 'tab_submit_worker_error') }
    };
  }
  try {
    const out = JSON.parse(String(worker.stdout || '{}'));
    return {
      ok: !!out.ok,
      status: out.status || (out.ok ? 'submitted' : 'blocked'),
      stage: out.stage || 'tab_submit',
      decision: out.ok ? 'GO' : 'NO_GO_REVIEW',
      reasons: Array.isArray(out.reasons) ? out.reasons : [out.reason || 'tab_submit_unknown'],
      bookmakerRef: out.bookmakerRef || { ticketId: null, reason: (out.reasons || ['tab_submit_unknown']).join(', ') }
    };
  } catch {
    const errText = String(worker.stderr || worker.stdout || 'tab_submit_parse_error').trim();
    return {
      ok: false,
      status: 'blocked',
      stage: 'tab_submit',
      decision: 'NO_GO_REVIEW',
      reasons: [errText || 'tab_submit_parse_error'],
      bookmakerRef: { ticketId: null, reason: errText || 'tab_submit_parse_error' }
    };
  }
}

function placeBetchaBet(order = {}, settings = {}) {
  const preflight = aiGoNoGo(order, { ...settings, platform: 'BETCHA' });
  if (preflight.decision !== 'GO') {
    return {
      ok: false,
      status: 'rejected',
      stage: 'preflight',
      decision: preflight.decision,
      reasons: preflight.reasons,
      bookmakerRef: { ticketId: null, reason: preflight.reasons.join(', ') }
    };
  }

  const betchaLive = String(process.env.AUTOBET_BETCHA_LIVE || process.env.AUTOBET_TAB_LIVE || 'false').toLowerCase() === 'true';
  if (!betchaLive) {
    return {
      ok: false,
      status: 'blocked',
      stage: 'adapter',
      decision: 'NO_GO_REVIEW',
      reasons: ['AUTOBET_BETCHA_LIVE_not_enabled'],
      bookmakerRef: { ticketId: null, reason: 'AUTOBET_BETCHA_LIVE_not_enabled' }
    };
  }

  const worker = spawnSync('node', [path.join(__dirname, 'betcha_submit_worker.js'), JSON.stringify({ order, settings })], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env }
  });
  if (worker.error) {
    return {
      ok: false,
      status: 'blocked',
      stage: 'betcha_submit',
      decision: 'NO_GO_REVIEW',
      reasons: [String(worker.error.message || 'betcha_submit_worker_error')],
      bookmakerRef: { ticketId: null, reason: String(worker.error.message || 'betcha_submit_worker_error') }
    };
  }
  try {
    const out = JSON.parse(String(worker.stdout || '{}'));
    return {
      ok: !!out.ok,
      status: out.status || (out.ok ? 'submitted' : 'blocked'),
      stage: out.stage || 'betcha_submit',
      decision: out.ok ? 'GO' : 'NO_GO_REVIEW',
      reasons: Array.isArray(out.reasons) ? out.reasons : [out.reason || 'betcha_submit_unknown'],
      bookmakerRef: out.bookmakerRef || { ticketId: null, reason: (out.reasons || ['betcha_submit_unknown']).join(', ') }
    };
  } catch {
    const errText = String(worker.stderr || worker.stdout || 'betcha_submit_parse_error').trim();
    return {
      ok: false,
      status: 'blocked',
      stage: 'betcha_submit',
      decision: 'NO_GO_REVIEW',
      reasons: [errText || 'betcha_submit_parse_error'],
      bookmakerRef: { ticketId: null, reason: errText || 'betcha_submit_parse_error' }
    };
  }
}

module.exports = {
  aiGoNoGo,
  placeTabBet,
  placeBetchaBet
};
