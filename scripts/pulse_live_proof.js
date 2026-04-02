#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'release-signoffs', 'artifacts');
fs.mkdirSync(OUT_DIR, { recursive: true });

const baseUrl = String(process.env.BETMAN_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const username = String(process.env.BETMAN_PROOF_USERNAME || '').trim();
const password = String(process.env.BETMAN_PROOF_PASSWORD || '').trim();
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-pulse-live-proof.json`);

function request(urlString, options = {}, body = null) {
  const url = new URL(urlString);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 10000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function fileSnapshot(filePath) {
  try {
    const st = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = tryJson(raw);
    return {
      path: path.relative(ROOT, filePath),
      exists: true,
      mtime: st.mtime.toISOString(),
      size: st.size,
      jsonSummary: parsed && typeof parsed === 'object' ? {
        updatedAt: parsed.updatedAt || null,
        alertsCount: Array.isArray(parsed.alerts) ? parsed.alerts.length : undefined,
        topLevelKeys: Object.keys(parsed).slice(0, 12),
      } : null,
    };
  } catch (err) {
    return { path: path.relative(ROOT, filePath), exists: false, error: err.message };
  }
}

async function main() {
  const result = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    deterministicEvidence: {},
    liveProbe: {},
    fileSnapshots: {},
    process: {},
    assessment: {},
  };

  try {
    result.deterministicEvidence.releaseCheckPulse = execFileSync('bash', ['scripts/release_check_pulse.sh'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    result.deterministicEvidence.ok = true;
  } catch (err) {
    result.deterministicEvidence.ok = false;
    result.deterministicEvidence.error = err.message;
    result.deterministicEvidence.stdout = String(err.stdout || '');
    result.deterministicEvidence.stderr = String(err.stderr || '');
  }

  try {
    const pid = execFileSync('pgrep', ['-f', 'node scripts/frontend_server.js'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    const ps = pid ? execFileSync('ps', ['-p', pid, '-o', 'pid=,lstart=,command='], { encoding: 'utf8' }).trim() : '';
    result.process.note = pid ? `Captured live BETMAN frontend_server candidate PID ${pid}.` : 'No frontend_server.js process found via pgrep.';
    result.process.pid = pid || null;
    result.process.ps = ps || null;
  } catch (err) {
    result.process.error = err.message;
  }

  result.fileSnapshots.defaultAlertsFeed = fileSnapshot(path.join(ROOT, 'frontend', 'data', 'alerts_feed.json'));
  result.fileSnapshots.defaultAlertsHistory = fileSnapshot(path.join(ROOT, 'frontend', 'data', 'alerts_history.json'));
  result.fileSnapshots.defaultPulseConfig = fileSnapshot(path.join(ROOT, 'frontend', 'data', 'pulse_config.json'));
  result.fileSnapshots.defaultStatus = fileSnapshot(path.join(ROOT, 'frontend', 'data', 'status.json'));
  result.fileSnapshots.tenantAlertsFeed = fileSnapshot(path.join(ROOT, 'memory', 'tenants', 'acct_test-betman-co-nz', 'frontend-data', 'alerts_feed.json'));
  result.fileSnapshots.tenantAlertsHistory = fileSnapshot(path.join(ROOT, 'memory', 'tenants', 'acct_test-betman-co-nz', 'frontend-data', 'alerts_history.json'));
  result.fileSnapshots.tenantStatus = fileSnapshot(path.join(ROOT, 'memory', 'tenants', 'acct_test-betman-co-nz', 'frontend-data', 'status.json'));

  const unauthHealth = await request(`${baseUrl}/api/health`);
  result.liveProbe.unauthHealth = {
    status: unauthHealth.status,
    body: tryJson(unauthHealth.body) || unauthHealth.body,
  };

  if (username && password) {
    const loginBody = JSON.stringify({ username, password });
    const login = await request(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, loginBody);
    const loginJson = tryJson(login.body);
    result.liveProbe.login = { status: login.status, body: loginJson || login.body };

    const cookie = String(login.headers['set-cookie'] || '').split(';', 1)[0];
    if (cookie) {
      for (const endpoint of ['/api/health', '/api/v1/pulse-config', '/api/v1/alerts-feed', '/api/v1/alerts-history']) {
        const resp = await request(`${baseUrl}${endpoint}`, { headers: { Cookie: cookie } });
        result.liveProbe[endpoint] = {
          status: resp.status,
          body: tryJson(resp.body) || resp.body,
        };
      }
    }
  } else {
    result.liveProbe.login = { skipped: true, reason: 'BETMAN_PROOF_USERNAME/BETMAN_PROOF_PASSWORD not set' };
  }

  const authHealthBody = result.liveProbe['/api/health']?.body || null;
  const pulseFeedBody = result.liveProbe['/api/v1/alerts-feed']?.body || null;
  const pulseConfigBody = result.liveProbe['/api/v1/pulse-config']?.body || null;

  const unauthBlocked = result.liveProbe.unauthHealth.status === 401;
  const pulseFeedUpdatedAt = pulseFeedBody?.updatedAt || null;
  const pulseAlertsCount = Array.isArray(pulseFeedBody?.alerts) ? pulseFeedBody.alerts.length : null;
  const tenantStatusUpdatedAt = result.fileSnapshots.tenantStatus?.jsonSummary?.updatedAt || null;

  const authProbeAttempted = !!(username && password);
  const pulseConfigReadable = result.liveProbe['/api/v1/pulse-config']?.status === 200;
  const pulseFeedReadable = result.liveProbe['/api/v1/alerts-feed']?.status === 200;

  result.assessment = {
    deterministicPulseEvidencePasses: !!result.deterministicEvidence.ok,
    liveUnauthHealthMatchesCurrentSourceExpectation: result.liveProbe.unauthHealth.status === 200,
    authProbeAttempted,
    livePulseConfigReadableWithAuth: pulseConfigReadable,
    livePulseFeedReadableWithAuth: pulseFeedReadable,
    livePulseFeedUpdatedAt: pulseFeedUpdatedAt,
    livePulseAlertsCount: pulseAlertsCount,
    tenantStatusUpdatedAt,
    conclusion: (() => {
      if (!result.deterministicEvidence.ok) return 'deterministic_evidence_failed';
      if (unauthBlocked) return 'deployment_parity_gap_detected';
      if (!authProbeAttempted) return 'public_health_parity_verified_auth_probe_skipped';
      if (!pulseConfigReadable || !pulseFeedReadable) return 'authenticated_probe_failed';
      if (pulseAlertsCount === 0) return 'live_pulse_observable_but_no_positive_signal_evidence';
      return 'positive_live_pulse_evidence_observed';
    })(),
    note: 'A passing deterministic Pulse release check proves source behavior under fixture control. It does not by itself prove the currently running deployed instance exposes the same behavior or currently has live Pulse signal output.'
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
