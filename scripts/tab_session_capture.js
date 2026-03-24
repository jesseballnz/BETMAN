#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function resolveChromiumPath(){
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Users/jesseball/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'data', 'autobet_settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function captureState(page, context, statusPath) {
  const cookies = await context.cookies().catch(() => []);
  const state = await page.evaluate(() => {
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const text = String(document.body?.innerText || '').toLowerCase();
    const hasLoginForm = !!document.querySelector('input[name="username"], input#username, input[type="password"]');
    const hasBetslipLogin = !![...document.querySelectorAll('button,a')].find(el => visible(el) && /login\s*&\s*bet/i.test((el.textContent || '').trim()));
    const hasStakeInput = !![...document.querySelectorAll('input')].find(i => visible(i) && (((i.placeholder || '').includes('0.00')) || /stake/i.test(i.name || '') || /stake/i.test(i.id || '') || /stake/i.test(i.getAttribute('aria-label') || '')));
    return {
      url: location.href,
      title: document.title || '',
      hasLoginForm,
      hasBetslipLogin,
      hasStakeInput,
      myBetsVisible: text.includes('my bets') || text.includes('deposit') || text.includes('account'),
      textSample: String(document.body?.innerText || '').slice(0, 1200)
    };
  }).catch(() => ({ url: page.url(), title:'', hasLoginForm:true, hasBetslipLogin:false, hasStakeInput:false, myBetsVisible:false, textSample:'' }));

  const authCookies = cookies.filter(c => /hydra|auth|session/i.test(String(c.name || '')) || /^ory_/i.test(String(c.name || '')))
    .map(c => ({ name: c.name, domain: c.domain, expires: c.expires }));
  const payload = {
    at: new Date().toISOString(),
    state,
    authCookies,
    cookieCount: cookies.length
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
  return { state, authCookies };
}

(async()=>{
  const settings = loadSettings();
  const chromiumPath = resolveChromiumPath();
  const launchOpts = chromiumPath ? { headless:false, executablePath:chromiumPath } : { headless:false };
  const browser = await chromium.launch(launchOpts);
  const storageStatePath = path.join(__dirname, '..', 'frontend', 'data', 'tab_storage_state.json');
  const statusPath = path.join(__dirname, '..', 'frontend', 'data', 'tab_session_capture_status.json');
  const stateOpts = fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : {};
  const context = await browser.newContext(stateOpts);
  const page = await context.newPage();
  await page.goto('https://www.tab.co.nz/account', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
  await page.waitForTimeout(1500);

  const fillLoginForm = async () => {
    const username = String(settings.username || '');
    const password = String(settings.password || '');
    if (!username || !password) return;
    await page.evaluate(({ username, password }) => {
      const setVal = (el, v) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter && el instanceof HTMLInputElement) setter.call(el, String(v));
        else el.value = String(v);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      };
      const userEl = document.querySelector('input[name="username"], input#username, input[placeholder*="Username" i], input[name="email"], input[type="email"]');
      const passEl = document.querySelector('input[name="password"], input#password, input[placeholder*="Password" i], input[type="password"]');
      setVal(userEl, username);
      setVal(passEl, password);
    }, { username, password }).catch(()=>{});
  };

  const maxWaitMs = Number(process.env.AUTOBET_TAB_CAPTURE_WAIT_MS || 600000);
  const started = Date.now();
  let ok = false;
  let lastPersist = 0;

  while ((Date.now() - started) < maxWaitMs) {
    await fillLoginForm();
    const { state, authCookies } = await captureState(page, context, statusPath);
    const hasAuthCookie = authCookies.length > 0;
    const loginUrl = /\/auth\/login|\/login/i.test(String(state.url || ''));
    const captureReady = hasAuthCookie && !loginUrl && !state.hasLoginForm && (!state.hasBetslipLogin || state.hasStakeInput || state.myBetsVisible);
    if (captureReady) {
      ok = true;
      break;
    }
    if (Date.now() - lastPersist > 10000) {
      await context.storageState({ path: storageStatePath }).catch(()=>{});
      lastPersist = Date.now();
    }
    await page.waitForTimeout(1000);
  }

  await context.storageState({ path: storageStatePath }).catch(()=>{});
  const finalState = await captureState(page, context, statusPath).catch(() => null);
  process.stdout.write(JSON.stringify({ ok, status: ok ? 'captured' : 'timeout', stage: 'session_capture', storageStatePath, finalState }));
  await browser.close();
})().catch(err => {
  process.stdout.write(JSON.stringify({ ok:false, status:'blocked', stage:'session_capture', reasons:[String(err.message || err)] }));
});
