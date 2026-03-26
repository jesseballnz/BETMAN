#!/usr/bin/env node
const fs = require('fs');
const { chromium } = require('playwright');

function resolveChromiumPath(){
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Users/jesseball/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function run(payload){
  const order = payload.order || {};
  const settings = payload.settings || {};
  const username = String(settings.username || '');
  const password = String(settings.password || '');
  if (!username || !password) return { ok:false, status:'rejected', stage:'credentials', reasons:['missing_credentials'] };

  const chromiumPath = resolveChromiumPath();
  const browser = await chromium.launch(chromiumPath ? { headless:true, executablePath:chromiumPath } : { headless:true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://www.betcha.co.nz/', { waitUntil:'domcontentloaded', timeout:60000 });

    const loggedIn = await page.locator('text=My Bets, text=Balance, text=Logout').first().isVisible().catch(()=>false);
    if (!loggedIn) {
      await page.goto('https://www.betcha.co.nz/login', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      const userSel = ['input[name="username"]','input[name="email"]','input[type="email"]'];
      const passSel = ['input[name="password"]','input[type="password"]'];
      for (const s of userSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, username); break; } }
      for (const s of passSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, password); break; } }
      await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Login")').catch(()=>{});
      await page.waitForTimeout(2500);
      // Do not hard-fail auth here; some layouts keep login controls in DOM when already authenticated.
    }

    const selection = String(order.selection || '').trim();
    const runnerNo = String(order.runnerNumber || order.runner_number || '').trim();
    if (!selection) return { ok:false, status:'rejected', stage:'order', reasons:['missing_selection'] };

    const authStillBlocked = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      const onLogin = /\/login/.test(String(location.pathname || '').toLowerCase());
      const hasAuthPrompt = t.includes('log in') || t.includes('login');
      const hasAccountSignals = t.includes('my account') || t.includes('my bets') || t.includes('betslip');
      return onLogin && hasAuthPrompt && !hasAccountSignals;
    }).catch(()=>false);
    if (authStillBlocked) {
      await browser.close();
      return { ok:false, status:'blocked', stage:'auth', reasons:['invalid_credentials'] };
    }

    const eventUrl = String(order.eventUrl || order.event_url || '').trim();
    if (eventUrl) {
      await page.goto(eventUrl, { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1200);
    } else {
      const meeting = String(order.meeting || '').trim();
      const raceNo = String(order.race || '').replace(/^R/i, '').trim();
      const meetingSlug = meeting.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      await page.goto(meetingSlug ? `https://www.betcha.co.nz/racing/${meetingSlug}` : 'https://www.betcha.co.nz/racing', { waitUntil:'domcontentloaded', timeout:60000 }).catch(()=>{});
      await page.waitForTimeout(1200);
      if (meetingSlug && raceNo) {
        const raceLink = page.locator(`a[href*="/racing/${meetingSlug}/"]:has-text("R${raceNo}")`).first();
        if (await raceLink.isVisible().catch(()=>false)) {
          await raceLink.click({ timeout: 5000 }).catch(()=>{});
          await page.waitForTimeout(1200);
        }
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

    const clickCandidates = [
      `tr.race-table-row:has-text("${selection}") button.odds-button`,
      `tr.race-table-row:has-text("${selection}")`,
      `[data-testid="race-table-row-favourite"]:has-text("${selection}")`,
      `[data-testid="runner-name"]:has-text("${selection}")`,
      runnerNo ? `tr.race-table-row:has-text("${runnerNo}."):has-text("${selection}")` : null,
      runnerNo ? `text=${runnerNo}. ${selection}` : null,
      runnerNo ? `text=${runnerNo}.` : null,
      `text=${selection}`,
      `button:has-text("${selection}")`,
      `[role="button"]:has-text("${selection}")`,
      `.runner:has-text("${selection}")`,
      `.selection:has-text("${selection}")`
    ].filter(Boolean);

    let selected = false;

    const clickedViaDom = await page.evaluate(({ selection, runnerNo }) => {
      const norm = (v) => String(v || '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
      const want = norm(selection);
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
      btn.click();
      return true;
    }, { selection, runnerNo }).catch(() => false);
    if (clickedViaDom) {
      await page.waitForTimeout(800);
      const hasSlip = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        return /pending bets\s*\(|total stake\s*:/i.test(txt);
      }).catch(()=>false);
      if (hasSlip) selected = true;
    }

    for (const s of clickCandidates) {
      if (selected) break;
      const loc = page.locator(s).first();
      const vis = await loc.isVisible().catch(()=>false);
      if (!vis) continue;
      await loc.click({ timeout: 5000 }).catch(()=>{});
      await page.waitForTimeout(800);
      const hasSlip = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        return /betslip|pending bets|stake/i.test(txt);
      }).catch(()=>false);
      if (hasSlip) { selected = true; break; }
    }
    if (!selected) {
      await browser.close();
      return { ok:false, status:'blocked', stage:'selection', reasons:['selection_not_added_to_betslip'] };
    }

    const stake = Number(order.stake || 0) || 1;
    const stakeSet = await page.evaluate((value) => {
      const selectors = [
        'input[name="stake"]',
        'input[name*="stake" i]',
        'input[placeholder*="stake" i]',
        'input[inputmode="decimal"]',
        'input[type="number"]',
        'input[type="text"]'
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter && el instanceof HTMLInputElement) setter.call(el, String(value));
        else el.value = String(value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      }
      return false;
    }, String(stake)).catch(()=>false);

    if (!stakeSet) {
      await browser.close();
      return { ok:false, status:'blocked', stage:'betcha_submit', reasons:['stake_input_not_found'] };
    }

    const submit = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => /place bet|place bets|submit|confirm/i.test((b.textContent || '').trim()));
      if (!btn) return { ok:false, reason:'submit_button_not_found' };
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok:false, reason:'submit_button_disabled' };
      btn.click();
      return { ok:true };
    }).catch(()=>({ ok:false, reason:'submit_button_not_found' }));

    if (!submit.ok) {
      await browser.close();
      return { ok:false, status:'blocked', stage:'betcha_submit', reasons:[submit.reason || 'submit_button_not_found'] };
    }

    await page.waitForTimeout(2500);
    const body = await page.textContent('body').catch(()=>"");
    const ticketMatch = String(body || '').match(/(ticket|reference)\s*[:#]?\s*([A-Z0-9-]{6,})/i);
    const ticketId = ticketMatch ? ticketMatch[2] : null;

    await browser.close();
    return {
      ok: true,
      status: 'submitted',
      stage: 'betcha_submit',
      reasons: ticketId ? ['submitted'] : ['submitted_unconfirmed_ticket'],
      bookmakerRef: { ticketId, reason: ticketId ? 'submitted' : 'submitted_unconfirmed_ticket' }
    };
  } catch (e) {
    await browser.close().catch(()=>{});
    return { ok:false, status:'blocked', stage:'betcha_submit', reasons:[String(e.message || 'betcha_submit_failed')] };
  }
}

(async () => {
  try {
    const payload = JSON.parse(process.argv[2] || '{}');
    const out = await run(payload);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok:false, status:'blocked', stage:'betcha_submit', reasons:[String(e.message || 'worker_failed')] }));
  }
})();
