#!/usr/bin/env node

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
  if (!['TAB', 'BOTH'].includes(String(settings.platform || 'TAB').toUpperCase())) reasons.push('platform_not_tab');
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

  // Final production submit step placeholder until selector/API map is finalized.
  return {
    ok: false,
    status: 'blocked',
    stage: 'tab_submit',
    decision: 'NO_GO_REVIEW',
    reasons: ['tab_submit_flow_pending_selector_map'],
    bookmakerRef: { ticketId: null, reason: 'tab_submit_flow_pending_selector_map' }
  };
}

module.exports = {
  aiGoNoGo,
  placeTabBet
};
