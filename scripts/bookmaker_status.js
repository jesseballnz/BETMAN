#!/usr/bin/env node
/* Fetch Betcha + TAB balances/open bets using Playwright (headless, session persistence). */
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

function writeJson(p, data){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function parseBalanceFromText(text){
  const matches = [...String(text || '').matchAll(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g)].map(m=>parseFloat(m[1]));
  if (!matches.length) return null;
  return matches[0] ?? null;
}

function parseAccountPair(text){
  const vals = [...String(text || '').matchAll(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g)].map(m=>parseFloat(m[1]));
  if (!vals.length) return { available: null, bonus: null };
  return { available: vals[0] ?? null, bonus: vals[1] ?? null };
}

function resolveChromiumPath(){
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Users/jesseball/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function betchaScrape(){
  const storageState = process.env.BETCHA_STORAGE_STATE || '';
  const chromiumPath = resolveChromiumPath();
  const launchOpts = chromiumPath ? { headless: true, executablePath: chromiumPath } : { headless: true };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(storageState && fs.existsSync(storageState) ? { storageState } : {});
  const page = await context.newPage();

  await page.goto('https://www.betcha.co.nz/', { waitUntil: 'domcontentloaded' });

  // login if needed
  const loggedIn = await page.locator('text=My Bets').first().isVisible().catch(()=>false);
  if (!loggedIn) {
    const username = process.env.BETCHA_USERNAME;
    const password = process.env.BETCHA_PASSWORD;
    if (!username || !password) throw new Error('Missing BETCHA credentials');

    // try common login flow
    await page.goto('https://www.betcha.co.nz/login', { waitUntil: 'domcontentloaded' }).catch(()=>{});
    const userSel = ['input[name="username"]','input[name="email"]','input[type="email"]'];
    const passSel = ['input[name="password"]','input[type="password"]'];

    for (const s of userSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, username); break; } }
    for (const s of passSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, password); break; } }
    await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Login")').catch(()=>{});
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(1500);
  const bodyText = await page.textContent('body').catch(()=>"");
  let balance = null;
  let bonusBalance = null;

  // Prefer the account header button: "person $54.41 $0.00"
  try {
    const acctTxt = await page.locator('button:has-text("person")').first().innerText();
    const pair = parseAccountPair(acctTxt);
    balance = pair.available;
    bonusBalance = pair.bonus;
  } catch {}

  if (balance == null) {
    try {
      const btnText = await page.locator('button:has-text("$")').first().innerText();
      const pair = parseAccountPair(btnText);
      balance = pair.available;
      bonusBalance = pair.bonus;
    } catch {}
  }

  if (balance == null) {
    balance = parseBalanceFromText(bodyText);
  }

  // open bets (best-effort)
  let openBets = null;
  try {
    const match = bodyText.match(/My Bets\s*(\d+)/i);
    if (match) openBets = parseInt(match[1],10);
  } catch {}

  if (storageState) {
    await context.storageState({ path: storageState });
  }
  await browser.close();
  return { balance, bonusBalance, openBets };
}

async function tabScrape(){
  const storageState = process.env.TAB_STORAGE_STATE || '';
  const chromiumPath = resolveChromiumPath();
  const launchOpts = chromiumPath ? { headless: true, executablePath: chromiumPath } : { headless: true };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(storageState && fs.existsSync(storageState) ? { storageState } : {});
  const page = await context.newPage();

  await page.goto('https://www.tab.co.nz/', { waitUntil: 'domcontentloaded' });

  const loggedIn = await page.locator('text=My Bets').first().isVisible().catch(()=>false);
  if (!loggedIn) {
    const username = process.env.TAB_USERNAME;
    const password = process.env.TAB_PASSWORD;
    if (!username || !password) throw new Error('Missing TAB credentials');

    await page.goto('https://www.tab.co.nz/login', { waitUntil: 'domcontentloaded' }).catch(()=>{});
    const userSel = ['input[name="username"]','input[name="email"]','input[type="email"]'];
    const passSel = ['input[name="password"]','input[type="password"]'];
    for (const s of userSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, username); break; } }
    for (const s of passSel) { if (await page.locator(s).first().isVisible().catch(()=>false)) { await page.fill(s, password); break; } }
    await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Login")').catch(()=>{});
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(1500);
  const bodyText = await page.textContent('body').catch(()=>"");
  let balance = null;

  try {
    const acctTxt = await page.locator('button:has-text("$")').first().innerText();
    balance = parseAccountPair(acctTxt).available;
  } catch {}

  if (balance == null) {
    balance = parseBalanceFromText(bodyText);
  }

  let openBets = null;
  try {
    const match = bodyText.match(/My Bets\s*(\d+)/i);
    if (match) openBets = parseInt(match[1],10);
  } catch {}

  if (storageState) {
    await context.storageState({ path: storageState });
  }
  await browser.close();
  return { balance, openBets };
}

async function main(){
  loadEnv(path.join(process.cwd(),'secrets','capital.env'));
  const out = { updatedAt: new Date().toISOString(), betcha: {}, tab: {} };
  const balancePath = path.join(process.cwd(),'memory','balance.json');
  const prev = (()=>{ try { return JSON.parse(fs.readFileSync(balancePath,'utf8')); } catch { return {}; } })();

  try { out.betcha = await betchaScrape(); } catch (e) { out.betcha = { error: e.message }; }
  try { out.tab = await tabScrape(); } catch (e) { out.tab = { error: e.message }; }

  // Preserve last known good values if current scrape returns null.
  if (out.betcha && out.betcha.balance == null && prev.betcha?.balance != null) out.betcha.balance = prev.betcha.balance;
  if (out.betcha && out.betcha.openBets == null && prev.betcha?.openBets != null) out.betcha.openBets = prev.betcha.openBets;
  if (out.tab && out.tab.balance == null && prev.tab?.balance != null) out.tab.balance = prev.tab.balance;
  if (out.tab && out.tab.openBets == null && prev.tab?.openBets != null) out.tab.openBets = prev.tab.openBets;

  writeJson(balancePath, out);
  console.log('balance.json updated');
}

main().catch(e=>{ console.error('Error:', e.message); process.exit(1); });
