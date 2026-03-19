#!/usr/bin/env node
/* Capture TAB balance-related API call outcomes from authenticated browser context. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function loadEnv(filePath){
  try {
    const txt = fs.readFileSync(filePath,'utf8');
    txt.split(/\r?\n/).forEach(line=>{
      const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  } catch {}
}

(async () => {
  loadEnv(path.join(process.cwd(), 'secrets', 'capital.env'));

  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Users/jesseball/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
  const storageState = process.env.TAB_STORAGE_STATE || '';

  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
  const context = await browser.newContext(storageState && fs.existsSync(storageState) ? { storageState } : {});
  const page = await context.newPage();

  const hits = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/api\.tab\.co\.nz\/v2\/(client\/Balance|toolbox\/balances)/i.test(url)) return;
    let body = '';
    try { body = await resp.text(); } catch {}
    hits.push({
      url,
      status: resp.status(),
      ok: resp.ok(),
      contentType: (resp.headers()['content-type'] || ''),
      bodySample: String(body).slice(0, 180),
      ts: new Date().toISOString()
    });
  });

  await page.goto('https://www.tab.co.nz/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const out = {
    checkedAt: new Date().toISOString(),
    count: hits.length,
    hits,
    successCount: hits.filter(h => h.ok).length
  };

  const outPath = path.join(process.cwd(), 'memory', 'api-balance-capture.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  await browser.close();

  console.log(JSON.stringify(out, null, 2));
  if (!out.successCount) process.exit(2);
})();
