#!/usr/bin/env node
/* Simple TAB affiliates API query helper */
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.tab.co.nz/affiliates/v1';

function getArg(name, def) {
  const idx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (idx === -1) return def;
  return process.argv[idx].split('=').slice(1).join('=') || def;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-tab-query/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function meetings() {
  const date = getArg('date', 'today');
  const country = getArg('country', 'AUS');
  const type = getArg('type', 'T');
  const limit = getArg('limit', '200');
  const offset = getArg('offset', '0');
  const qs = new URLSearchParams({ date_from: date, date_to: date, country, type, limit, offset });
  return fetchJson(`${BASE}/racing/meetings?${qs}`);
}

async function event() {
  const id = getArg('id');
  if (!id) throw new Error('Missing --id=<event_id>');
  const params = new URLSearchParams({
    with_money_tracker: 'true',
    with_big_bets: 'true',
    with_biggest_bet: 'true',
    with_tote_trends_data: 'true',
    present_overlay: 'false'
  });
  return fetchJson(`${BASE}/racing/events/${id}?${params}`);
}

async function races() {
  const channel = getArg('channel', 'Trackside1');
  const date = getArg('date', 'today');
  const type = getArg('type', 'T');
  const qs = new URLSearchParams({ channel, type, date });
  return fetchJson(`${BASE}/racing/races?${qs}`);
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !['meetings','event','races'].includes(mode)) {
    console.error('usage: tab_api_query.js <meetings|event|races> [--date=YYYY-MM-DD|today] [--country=AUS] [--type=T] [--id=EVENT_ID] [--channel=Trackside1]');
    process.exit(2);
  }
  let data;
  if (mode === 'meetings') data = await meetings();
  if (mode === 'event') data = await event();
  if (mode === 'races') data = await races();
  console.log(JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
