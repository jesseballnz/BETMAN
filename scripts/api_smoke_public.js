#!/usr/bin/env node
/* Public API smoke checks for TAB endpoints. */
const fs = require('fs');
const path = require('path');
const https = require('https');

function get(url){
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ url, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: data.slice(0, 180) }));
    });
    req.on('error', (e) => resolve({ url, ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

(async () => {
  const urls = [
    'https://www.tab.co.nz/cfg/web.js',
    'https://status-api.production.tab.co.nz/index.json',
    'https://api.tab.co.nz/insights/sync'
  ];
  const results = [];
  for (const u of urls) results.push(await get(u));
  const payload = { checkedAt: new Date().toISOString(), results };
  const outPath = path.join(process.cwd(), 'memory', 'api-smoke-public.json');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  } catch {}
  console.log(JSON.stringify(payload, null, 2));
  const failed = results.filter(r => {
    if (r.url.includes('/insights/sync') && r.status === 415) return false; // endpoint reachable; expects specific content-type payload
    return !r.ok;
  });
  if (failed.length) process.exit(1);
})();
