#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'frontend');
const DATA_DIR = path.join(process.cwd(), 'data');
const PORT = Number(process.env.PORT || 9080);
const HOST = process.env.HOST || '0.0.0.0';

function loadJson(filePath, fallback = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '1; mode=block',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function safePath(requestPath) {
  const filePath = path.normalize(path.join(ROOT, requestPath));
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function normalizeFilter(value) {
  if (value === null || value === undefined) return null;
  const norm = String(value).trim().toUpperCase();
  return norm.length ? norm : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'sportr-api', ts: new Date().toISOString() }), 'application/json');
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    const schedule = loadJson(path.join(DATA_DIR, 'sample-schedule.json'), { updatedAt: null, leagues: [] });
    const filterValues = [
      ...url.searchParams.getAll('league'),
      ...url.searchParams.getAll('sport'),
      ...url.searchParams.getAll('filter')
    ]
      .flatMap(value => String(value || '').split(','))
      .map(normalizeFilter)
      .filter(value => value && value !== 'ALL');

    let leagues = Array.isArray(schedule.leagues) ? schedule.leagues : [];
    if (filterValues.length) {
      const matchesFilter = (league) => {
        const code = normalizeFilter(league?.code);
        const name = normalizeFilter(league?.name);
        if (code && filterValues.includes(code)) return true;
        if (name && filterValues.includes(name)) return true;
        return false;
      };
      leagues = leagues.filter(matchesFilter);
    }

    const payload = { ...schedule, leagues };
    return send(res, 200, JSON.stringify(payload), 'application/json');
  }

  if (req.method === 'GET' && url.pathname === '/api/market') {
    const snapshot = loadJson(path.join(DATA_DIR, 'market_snapshot.json'), { generatedAt: null, events: [] });
    return send(res, 200, JSON.stringify(snapshot), 'application/json');
  }

  const staticPath = safePath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!staticPath) return send(res, 403, 'forbidden');
  if (!fs.existsSync(staticPath)) return send(res, 404, 'not found');

  const ext = path.extname(staticPath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return send(res, 200, fs.readFileSync(staticPath), types[ext] || 'application/octet-stream');
});

server.listen(PORT, HOST, () => {
  const printableHost = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST;
  console.log(`Sportr server listening on http://${printableHost}:${PORT}`);
});
