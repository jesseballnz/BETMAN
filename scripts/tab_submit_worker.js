#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEBUG_DIR = path.join(__dirname, '..', 'frontend', 'data');

async function captureDebugSnapshot(page, tag = 'debug', extras = {}) {
  try {
    const details = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
        .slice(0, 40)
        .map(el => ({
          text: (el.textContent || el.value || '').trim(),
          disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          classes: String(el.className || ''),
          dataTestId: el.getAttribute('data-testid') || ''
        }));
      const inputs = [...document.querySelectorAll('input')]
        .slice(0, 40)
        .map(el => ({
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: el.value || '',
          classes: String(el.className || '')
        }));
      return {
        url: String(location.href || ''),
        title: document.title || '',
        bodyText,
        buttons,
        inputs
      };
    }).catch(() => ({ url: page.url(), title: '', bodyText: '', buttons: [], inputs: [] }));

    const payload = {
      at: new Date().toISOString(),
      tag,
      url: details.url || page.url(),
      title: details.title || '',
      textSample: String(details.bodyText || '').slice(0, 5000),
      buttons: details.buttons || [],
      inputs: details.inputs || [],
      extras
    };
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `tab_debug_${tag}_last.json`), JSON.stringify(payload, null, 2));
    fs.writeFileSync(path.join(DEBUG_DIR, 'tab_debug_last.json'), JSON.stringify(payload, null, 2));
    await page.screenshot({ path: path.join(DEBUG_DIR, `tab_debug_${tag}.png`), fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('tab_debug_snapshot_failed', tag, err?.message || err);
  }
}

function resolveChromiumPath(){
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function run(payload){
  const order = payload.order || {};
  const settings = payload.settings || {};
  const username = String(settings.username || '');
  const password = String(settings.password || '');
  if (!username || !password) {
    return { ok:false, status:'rejected', stage:'credentials', reasons:['missing_credentials'] };
  }

  const chromiumPath = resolveChromiumPath();
  const headless = String(process.env.AUTOBET_TAB_HEADLESS || 'false').toLowerCase() === 'true';
  const launchOpts = chromiumPath ? { headless, executablePath:chromiumPath } : { headless };
  const browser = await chromium.launch(launchOpts);
  const storageStatePath = path.join(__dirname, '..', 'frontend', 'data', 'tab_storage_state.json');
  let context;
  let contextInitError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stateOpts = fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : {};
      context = await browser.newContext(stateOpts);
      break;
    } catch (err) {
      contextInitError = err;
      if (attempt === 0 && fs.existsSync(storageStatePath)) {
        try { fs.unlinkSync(storageStatePath); } catch {}
        continue;
      }
      await browser.close().catch(() => {});
      throw err;
    }
  }
  if (!context) {
    await browser.close().catch(() => {});
    throw contextInitError || new Error('tab_context_init_failed');
  }
  const page = await context.newPage();
  const persistState = async () => {
    try {
      fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
      await context.storageState({ path: storageStatePath });
    } catch (err) {
      console.error('tab_persist_state_failed', err?.message || err);
    }
  };

  try {
    await page.goto('https://www.tab.co.nz/racing', { waitUntil:'domcontentloaded', timeout:60000 });
    const loggedIn = await page.locator('text=My Bets').first().isVisible().catch(()=>false);
    if (!loggedIn) {
      // Trigger challenge-based auth flow and wait for the real login form to render.
      await page.goto('https://www.tab.co.nz/account', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1500);
      const userSel = ['input[name="username"]','input#username','input[placeholder*="Username" i]','input[name="email"]','input[type="email"]'];
      const passSel = ['input[name="password"]','input#password','input[placeholder*="Password" i]','input[type="password"]'];
      const userSelJoined = userSel.join(',');
      const passSelJoined = passSel.join(',');
      await page.waitForURL(/\/auth\/login|\/login/i, { timeout: 10000 }).catch(()=>{});
      await page.locator(userSelJoined).first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
      for (const s of userSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.locator(s).first().fill(username).catch(()=>{}); break; } }
      for (const s of passSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.locator(s).first().fill(password).catch(()=>{}); break; } }
      await page.evaluate(({ username, password }) => {
        const setVal = (el, v) => {
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && el instanceof HTMLInputElement) setter.call(el, String(v));
          else el.value = String(v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        };
        const u = document.querySelector('input[name="username"], input#username, input[placeholder*="Username" i], input[name="email"], input[type="email"]');
        const p = document.querySelector('input[name="password"], input#password, input[placeholder*="Password" i], input[type="password"]');
        setVal(u, username || '');
        setVal(p, password || '');
      }, { username, password }).catch(()=>{});
      await page.click('button[type="submit"], button:has-text("Log In"), button:has-text("Log in"), button:has-text("Login")').catch(()=>{});
      await page.waitForTimeout(3000);
    }

    const sel = String(order.selection || '').trim();
    const runnerNo = String(order.runnerNumber || order.runner_number || '').trim();
    if (!sel) return { ok:false, status:'rejected', stage:'order', reasons:['missing_selection'] };

    const meeting = String(order.meeting || '').trim();
    const raceNo = String(order.race || '').replace(/^R/i, '').trim();
    const meetingSlug = meeting.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const navigateLatestRaceUrl = async () => {
      await page.goto('https://www.tab.co.nz/racing', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1000);
      const rel = await page.evaluate(({ meeting, raceNo }) => {
        const wantMeeting = String(meeting || '').trim().toLowerCase();
        const wantRace = String(raceNo || '').trim();
        const links = [...document.querySelectorAll('a[href*="/racing/"]')];
        const hit = links.find(a => {
          const t = String(a.textContent || '').replace(/\s+/g, ' ').toLowerCase();
          return t.includes(wantMeeting) && (wantRace ? t.includes(`r${wantRace.toLowerCase()}`) : true);
        });
        return hit ? String(hit.getAttribute('href') || '') : '';
      }, { meeting, raceNo }).catch(()=> '');
      if (rel) {
        const abs = rel.startsWith('http') ? rel : `https://www.tab.co.nz${rel}`;
        await page.goto(abs, { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
        await page.waitForTimeout(1200);
      }
    };

    const eventUrl = String(order.eventUrl || order.event_url || '').trim();
    if (eventUrl) {
      await page.goto(eventUrl, { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1000);
      const hasRunnerHint = await page.evaluate((sel) => String(document.body?.innerText || '').toLowerCase().includes(String(sel || '').toLowerCase())).catch(()=>false);
      if (!hasRunnerHint) {
        await navigateLatestRaceUrl();
      }
    } else {
      // Deterministic fallback navigation: meeting -> race card.
      await page.goto(meetingSlug ? `https://www.tab.co.nz/racing/${meetingSlug}` : 'https://www.tab.co.nz/racing', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1200);
      if (meetingSlug && raceNo) {
        const raceLink = page.locator(`a[href*="/racing/${meetingSlug}/"]:has-text("R${raceNo}")`).first();
        if (await raceLink.isVisible().catch(()=>false)) {
          await raceLink.click({ timeout: 5000 }).catch(()=>{});
          await page.waitForTimeout(1200);
        } else {
          await navigateLatestRaceUrl();
        }
      } else {
        await navigateLatestRaceUrl();
      }
      if (meeting) {
        await page.locator(`text=${meeting}`).first().click({ timeout: 5000 }).catch(()=>{});
        await page.waitForTimeout(800);
      }
      if (raceNo) {
        await page.locator(`text=R${raceNo}`).first().click({ timeout: 5000 }).catch(()=>{});
        await page.waitForTimeout(1200);
      }
    }

    const readBetslipCount = async () => {
      try {
        const txt = await page.locator('button:has-text("Betslip")').first().innerText();
        const m = String(txt || '').match(/(\d+)/);
        return m ? Number(m[1]) : 0;
      } catch { return 0; }
    };

    const beforeCount = await readBetslipCount();

    // Direct DOM click path (most reliable on TAB): click first odds button in matching runner row.
    const clickedViaDom = await page.evaluate(({ sel, runnerNo }) => {
      const norm = (v) => String(v || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
      const want = norm(sel);
      const rows = [...document.querySelectorAll('tr.race-table-row')];
      const row = rows.find(r => {
        const txt = norm(r.textContent || '');
        if (!txt.includes(want)) return false;
        if (!runnerNo) return true;
        return txt.includes(`${runnerNo}.`) || txt.includes(` ${runnerNo} `);
      });
      if (!row) return false;
      const btn = row.querySelector('button.odds-button, button[data-testid^="price-button-"]');
      if (!btn) return false;
      const ev = (type) => btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window }));
      ev('pointerdown'); ev('mousedown'); ev('pointerup'); ev('mouseup'); ev('click');
      return true;
    }, { sel, runnerNo }).catch(() => false);
    if (clickedViaDom) await page.waitForTimeout(700);

    const selCandidates = [
      `tr.race-table-row:has-text("${sel}") button.odds-button`,
      `tr.race-table-row:has-text("${sel}")`,
      `[data-testid="race-table-row-favourite"]:has-text("${sel}")`,
      `[data-testid="runner-name"]:has-text("${sel}")`,
      runnerNo ? `tr.race-table-row:has-text("${runnerNo}."):has-text("${sel}")` : null,
      runnerNo ? `text=${runnerNo}. ${sel}` : null,
      runnerNo ? `text=${runnerNo} ${sel}` : null,
      runnerNo ? `text=${runnerNo}.` : null,
      runnerNo ? `button:has-text("${runnerNo}.")` : null,
      `text=${sel}`,
      `button:has-text("${sel}")`,
      `[role="button"]:has-text("${sel}")`
    ].filter(Boolean);
    for (const s of selCandidates) {
      const loc = page.locator(s).first();
      const vis = await loc.isVisible().catch(()=>false);
      if (!vis) continue;
      await loc.click({ timeout:5000 }).catch(()=>{});
      await page.waitForTimeout(600);
      if ((await readBetslipCount()) > beforeCount) break;
    }
    await page.waitForTimeout(1200);
    let afterCount = await readBetslipCount();

    // Some TAB flows require an explicit "Add to Betslip" click after selecting odds.
    if (afterCount <= beforeCount) {
      await page.locator('button:has-text("Add to Betslip")').first().click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(700);
      afterCount = await readBetslipCount();
    }
    if (afterCount <= beforeCount) {
      const slipReady = await page.evaluate(() => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const stakeInput = [...document.querySelectorAll('input')].find(i => visible(i) && ((i.placeholder || '').includes('0.00') || /stake/i.test(i.name || '') || /stake/i.test(i.id || '')));
        return !!stakeInput;
      }).catch(()=>false);
      if (slipReady) {
        afterCount = beforeCount + 1; // force-advance when slip is clearly ready but count badge is stale.
      }
    }

    if (afterCount <= beforeCount) {
      const allowFallbackSelection = String(process.env.AUTOBET_TAB_ALLOW_FALLBACK_SELECTION || 'false').toLowerCase() === 'true';
      if (allowFallbackSelection) {
        const fallbackClicked = await page.evaluate(() => {
          const btn = document.querySelector('tr.race-table-row button.odds-button, tr.race-table-row button[data-testid^="price-button-"]');
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, view: window }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
          btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, composed: true, view: window }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
          return true;
        }).catch(()=>false);
        if (fallbackClicked) {
          await page.waitForTimeout(900);
          afterCount = await readBetslipCount();
        }
      }
      if (afterCount <= beforeCount) {
        const runnerVisible = await page.evaluate(({ sel, runnerNo }) => {
          const norm = (v) => String(v || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
          const want = norm(sel);
          const txt = norm(document.body?.innerText || '');
          if (!txt.includes(want)) return false;
          if (!runnerNo) return true;
          return txt.includes(`${runnerNo}.`) || txt.includes(` ${runnerNo} `);
        }, { sel, runnerNo }).catch(()=>false);
        await captureDebugSnapshot(page, 'selection_fail', { sel, runnerNo, meeting, raceNo, context: runnerVisible ? 'runner_visible_not_added' : 'runner_not_found' });
        await persistState();
        await browser.close();
        return { ok:false, status:'blocked', stage:'selection', reasons:[runnerVisible ? 'selection_not_added_to_betslip' : 'runner_not_found_on_race_page'] };
      }
    }

    const getAuthState = async () => page.evaluate(() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const text = String(document.body?.innerText || '').toLowerCase();
      const hasLoginForm = !!document.querySelector('input[name="username"], input#username, input[type="password"]');
      const hasBetslipLogin = !![...document.querySelectorAll('button,a')].find(el => visible(el) && /login\s*&\s*bet/i.test((el.textContent || '').trim()));
      const hasStakeInput = !![...document.querySelectorAll('input')].find(i => visible(i) && (((i.placeholder || '').includes('0.00')) || /stake/i.test(i.name || '') || /stake/i.test(i.id || '') || /stake/i.test(i.getAttribute('aria-label') || '')));
      return { text, hasLoginForm, hasBetslipLogin, hasStakeInput, url: location.href, title: document.title || '' };
    }).catch(() => ({ text:'', hasLoginForm:false, hasBetslipLogin:false, hasStakeInput:false, url: page.url(), title:'' }));

    let authState = await getAuthState();
    let authBlocked = authState.hasLoginForm || (authState.hasBetslipLogin && !authState.hasStakeInput);

    if (authBlocked) {
      // In-page login modal fallback for TAB race pages.
      await page.locator('[data-testid="login-and-bet"], button:has-text("Login & Bet"), button:has-text("Login"), a:has-text("Login")').first().click({ timeout: 5000 }).catch(()=>{});
      await page.waitForTimeout(900);
      await page.evaluate(({ username, password }) => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        const userEl = inputs.find(i => {
          const t = String(i.type || '').toLowerCase();
          const p = String(i.placeholder || '').toLowerCase();
          const a = String(i.getAttribute('aria-label') || '').toLowerCase();
          return t === 'email' || p.includes('email') || p.includes('username') || a.includes('email') || a.includes('username');
        }) || inputs.find(i => String(i.type || '').toLowerCase() === 'text');
        const passEl = inputs.find(i => String(i.type || '').toLowerCase() === 'password');
        const setVal = (el, v) => {
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && el instanceof HTMLInputElement) setter.call(el, String(v));
          else el.value = String(v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        };
        setVal(userEl, username || '');
        setVal(passEl, password || '');
      }, { username: settings.username || '', password: settings.password || '' }).catch(()=>{});
      await page.locator('button:has-text("Login"), button:has-text("Log in"), button[type="submit"]').first().click({ timeout: 5000 }).catch(()=>{});
      await page.waitForTimeout(1500);

      authState = await getAuthState();
      authBlocked = authState.hasLoginForm || (authState.hasBetslipLogin && !authState.hasStakeInput);
    }

    const manualAuthWait = Number(process.env.AUTOBET_TAB_AUTH_WAIT_MS || 0);
    if (manualAuthWait > 0) {
      await page.waitForTimeout(manualAuthWait);
      authState = await getAuthState();
      authBlocked = authState.hasLoginForm || (authState.hasBetslipLogin && !authState.hasStakeInput);
    }

    if (authBlocked) {
      const authInfo = await page.evaluate(() => {
        const bodyText = String(document.body?.innerText || '');
        const errorNodes = [...document.querySelectorAll('[class*="error"], .error, .alert, .message')]
          .slice(0, 8)
          .map(el => (el.textContent || '').trim())
          .filter(Boolean);
        return {
          url: location.href,
          title: document.title,
          bodyText,
          errorNodes
        };
      }).catch(() => ({ bodyText: '', errorNodes: [] }));
      const haystack = `${(authInfo.errorNodes || []).join(' ')} ${authInfo.bodyText || ''}`;
      const hasBadCred = /incorrect|invalid password|account locked|credentials|do not match|try again|unsuccessful login/i.test(haystack);
      const reason = hasBadCred ? 'invalid_credentials' : 'login_required';
      await captureDebugSnapshot(page, 'auth_blocked', { reason, authInfo });
      try { fs.unlinkSync(storageStatePath); } catch {}
      await persistState();
      await browser.close();
      return { ok:false, status:'blocked', stage:'auth', reasons:[reason] };
    }

    const stake = Number(order.stake || 0) || 1;
    const stakeSelectors = [
      'input[name="stake"]',
      'input[name*="stake" i]',
      'input[placeholder*="Stake" i]',
      'input[placeholder="0.00"]',
      'input[aria-label*="Stake" i]',
      'input[inputmode="decimal"]',
      'input[type="number"]',
      'input[type="text"]',
      'input[type="tel"]',
      '[role="textbox"]',
      '[contenteditable="true"][aria-label*="stake" i]'
    ];

    const tryFillInFrame = async (ctx, selector, value) => {
      const loc = ctx.locator(selector).first();
      const vis = await loc.isVisible().catch(()=>false);
      if (!vis) return false;

      // Playwright-native paths first.
      try {
        await loc.click();
        await loc.fill(String(value));
      } catch {
        try {
          await loc.click();
          await loc.press('Meta+A').catch(()=>{});
          await loc.type(String(value), { delay: 40 });
        } catch {
          // React-controlled fallback: native value setter + bubbling events.
          try {
            await loc.evaluate((el, v) => {
              const input = el;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (setter && input instanceof HTMLInputElement) {
                setter.call(input, String(v));
              } else if ('value' in input) {
                input.value = String(v);
              }
              input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
              input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1' }));
              input.blur();
            }, String(value));
          } catch {
            return false;
          }
        }
      }

      try {
        const val = await loc.inputValue().catch(async () => {
          return await loc.evaluate((el) => ('value' in el ? String(el.value || '') : ''));
        });
        const n = Number(String(val || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && n > 0) return true;
      } catch {}
      return true;
    };

    let stakeFilled = false;
    for (const s of stakeSelectors) {
      if (await tryFillInFrame(page, s, stake)) { stakeFilled = true; break; }
    }

    if (!stakeFilled) {
      await page.click('button:has-text("Bet Slip"), button:has-text("Betslip"), [aria-label*="Bet Slip" i]').catch(()=>{});
      await page.waitForTimeout(800);
      for (const s of stakeSelectors) {
        if (await tryFillInFrame(page, s, stake)) { stakeFilled = true; break; }
      }
    }

    if (!stakeFilled) {
      for (const frame of page.frames()) {
        for (const s of stakeSelectors) {
          if (await tryFillInFrame(frame, s, stake)) { stakeFilled = true; break; }
        }
        if (stakeFilled) break;
      }
    }

    if (!stakeFilled) {
      // Broad fallback: try any visible text/number input on page.
      stakeFilled = await page.evaluate((stakeVal) => {
        const asNum = Number(stakeVal || 0) || 1;
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && el instanceof HTMLInputElement) setter.call(el, String(v));
          else if ('value' in el) el.value = String(v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        for (const el of inputs) {
          const t = String(el.type || '').toLowerCase();
          if (t && !['text','number','tel','search'].includes(t)) continue;
          setVal(el, asNum);
          return true;
        }
        return false;
      }, stake).catch(()=>false);
    }

    if (!stakeFilled) {
      await captureDebugSnapshot(page, 'stake_input_missing', { sel, runnerNo, meeting, raceNo, stake });
      await persistState();
      await browser.close();
      return { ok:false, status:'blocked', stage:'tab_submit', reasons:['stake_input_not_found'] };
    }

    const stakeBound = await page.evaluate(() => {
      const txt = document.body?.innerText || '';
      const m = txt.match(/Total Stake:\s*\$([0-9.,]+)/i);
      if (!m) return false;
      const n = Number(String(m[1] || '').replace(/,/g, ''));
      return Number.isFinite(n) && n > 0;
    }).catch(() => false);
    let stakeBoundFinal = stakeBound;
    if (!stakeBoundFinal) {
      // Last-chance brute-force bind across visible inputs.
      stakeBoundFinal = await page.evaluate((stakeVal) => {
        const asNum = Number(stakeVal || 0) || 1;
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && el instanceof HTMLInputElement) setter.call(el, String(v));
          else if ('value' in el) el.value = String(v);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: String(v).slice(-1) }));
          if (typeof el.blur === 'function') el.blur();
        };

        const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const inputs = [...document.querySelectorAll('input')].filter(isVisible);
        for (const el of inputs) {
          const type = String(el.type || '').toLowerCase();
          if (type && !['text', 'number', 'tel', 'search'].includes(type)) continue;
          setVal(el, asNum);
          const txt = document.body?.innerText || '';
          const m = txt.match(/Total Stake:\s*\$([0-9.,]+)/i);
          const n = m ? Number(String(m[1] || '').replace(/,/g, '')) : 0;
          if (Number.isFinite(n) && n > 0) return true;
        }
        return false;
      }, stake).catch(() => false);
    }
    if (!stakeBoundFinal) {
      await captureDebugSnapshot(page, 'stake_bind_failed', { sel, runnerNo, meeting, raceNo, stake });
      await persistState();
      await browser.close();
      return { ok:false, status:'blocked', stage:'tab_submit', reasons:['stake_not_bound_to_betslip'] };
    }

    if (String(process.env.AUTOBET_TAB_DRY_RUN || 'false').toLowerCase() === 'true') {
      await captureDebugSnapshot(page, 'dry_run_ready', { sel, runnerNo, meeting, raceNo, stake, url: page.url() });
      await persistState();
      await browser.close();
      return {
        ok: true,
        status: 'ready',
        stage: 'tab_submit',
        bookmakerRef: { ticketId: null, reason: 'dry_run_ready' },
        reasons: ['dry_run_ready']
      };
    }

    const submitSelectors = [
      'button:has-text("Place Bets")',
      'button:has-text("Place Bet")',
      'button:has-text("Bet Now")',
      'button:has-text("Place")',
      'button:has-text("Submit")',
      'button:has-text("Confirm")',
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    let clicked = false;
    let sawDisabled = false;
    for (const s of submitSelectors) {
      const btn = page.locator(s).first();
      const vis = await btn.isVisible().catch(()=>false);
      if (!vis) continue;
      const enabled = await btn.isEnabled().catch(()=>false);
      if (!enabled) { sawDisabled = true; continue; }
      await btn.click().catch(()=>{});
      clicked = true;
      break;
    }

    if (!clicked) {
      const domClicked = await page.evaluate(() => {
        const score = (txt) => {
          const t = String(txt || '').toLowerCase();
          if (!t) return -1;
          if (/remove|delete|clear|cancel/.test(t)) return -1;
          if (/place\s*bets?/.test(t)) return 9;
          if (/bet\s*now/.test(t)) return 8;
          if (/confirm/.test(t)) return 7;
          if (/submit/.test(t)) return 6;
          if (/place|bet/.test(t)) return 5;
          return -1;
        };
        const els = [...document.querySelectorAll('button,input[type="submit"],a[role="button"]')]
          .map(el => ({ el, txt: (el.textContent || el.value || '').trim() }))
          .map(x => ({ ...x, s: score(x.txt), disabled: x.el.disabled || x.el.getAttribute('aria-disabled') === 'true' }))
          .filter(x => x.s >= 0)
          .sort((a,b) => b.s - a.s);
        const target = els.find(x => !x.disabled);
        if (!target) return { ok:false, disabled: els.length > 0 };
        target.el.click();
        return { ok:true };
      }).catch(() => ({ ok:false, disabled:false }));
      clicked = !!domClicked.ok;
      if (!clicked && domClicked.disabled) sawDisabled = true;
    }

    if (!clicked) {
      await captureDebugSnapshot(page, 'submit_button_missing', { sel, runnerNo, meeting, raceNo, stake, sawDisabled });
      await persistState();
      await browser.close();
      return { ok:false, status:'blocked', stage:'tab_submit', reasons:[sawDisabled ? 'submit_button_disabled' : 'submit_button_not_found'] };
    }

    await page.waitForTimeout(2500);
    const body = await page.textContent('body').catch(()=>"");
    const bodyTxt = String(body || '');
    const ticketMatch = bodyTxt.match(/(ticket|reference)\s*[:#]?\s*([A-Z0-9-]{6,})/i);
    const ticketId = ticketMatch ? ticketMatch[2] : null;
    const placedMsg = /bet\s+placed|bet\s+accepted|successfully\s+placed|placed\s+successfully/i.test(bodyTxt);

    if (!ticketId && !placedMsg) {
      await captureDebugSnapshot(page, 'submit_unconfirmed', { bodySample: bodyTxt.slice(0, 2000) });
      await persistState();
      await browser.close();
      return {
        ok: false,
        status: 'blocked',
        stage: 'tab_submit',
        bookmakerRef: { ticketId: null, reason: 'submitted_unconfirmed_ticket' },
        reasons: ['submitted_unconfirmed_ticket']
      };
    }
    await persistState();
      await browser.close();
    return {
      ok: true,
      status: 'submitted',
      stage: 'tab_submit',
      bookmakerRef: { ticketId, reason: 'submitted' },
      reasons: ['submitted']
    };
  } catch (e) {
    await browser.close().catch(()=>{});
    return { ok:false, status:'blocked', stage:'tab_submit', reasons:[String(e.message || 'submit_failed')] };
  }
}

(async () => {
  try {
    const payloadRaw = process.env.AUTOBET_PAYLOAD_FILE
      ? fs.readFileSync(process.env.AUTOBET_PAYLOAD_FILE, 'utf8')
      : (process.argv[2] || '{}');
    const payload = JSON.parse(payloadRaw);
    const out = await run(payload);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok:false, status:'blocked', stage:'tab_submit', reasons:[String(e.message || 'worker_failed')] }));
  }
})();
