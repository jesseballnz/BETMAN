const { chromium } = require('playwright');
const path = require('path');

(async()=>{
  const outDir = path.join(__dirname, '..', 'frontend', 'assets');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });

  await page.goto('http://127.0.0.1:8080/landing', { waitUntil: 'networkidle' });
  await page.fill('#loginUsername', 'betman');
  await page.fill('#loginPassword', 'betman1234');
  await Promise.all([
    page.waitForURL(url => !url.toString().includes('/landing'), { timeout: 15000 }).catch(() => {}),
    page.click('#loginBtn')
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});

  const shots = [
    { name: 'marketing-web-workspace.png', url: 'http://127.0.0.1:8080/' },
    { name: 'marketing-web-pulse.png', url: 'http://127.0.0.1:8080/?tab=alerts' },
    { name: 'marketing-web-tracked.png', url: 'http://127.0.0.1:8080/?tab=tracked' },
    { name: 'marketing-web-ai-analysis.png', url: 'http://127.0.0.1:8080/?tab=chat' }
  ];

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: 'networkidle' }).catch(() => {});
    await page.screenshot({ path: path.join(outDir, shot.name), fullPage: true });
    console.log(shot.name);
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
