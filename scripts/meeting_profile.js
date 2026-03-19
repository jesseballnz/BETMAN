#!/usr/bin/env node
/* Build rolling meeting profile from TAB affiliates results. NZ: optionally archive loveracing pages (public). */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://api.tab.co.nz/affiliates/v1';

function getArg(name, def) {
  const idx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (idx === -1) return def;
  return process.argv[idx].split('=').slice(1).join('=') || def;
}

function fetchJson(url, retries = 3, delayMs = 500) {
  return new Promise((res, rej) => {
    const attempt = (left, wait) => {
      https.get(url, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try { res(JSON.parse(d)); } catch (e) { rej(e); }
        });
      }).on('error', err => {
        if (err.code === 'EADDRNOTAVAIL' && left > 0) {
          setTimeout(() => attempt(left - 1, wait * 2), wait);
        } else {
          rej(err);
        }
      });
    };
    attempt(retries, delayMs);
  });
}

function safeSlug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || '_';
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const date = getArg('date', 'today');
  const country = getArg('country', 'AUS');
  const includeNZLoveracing = getArg('loveracing', 'false') === 'true';

  const qs = new URLSearchParams({ date_from: date, date_to: date, country, type: 'T', limit: '200', offset: '0' });
  const meetings = await fetchJson(`${BASE}/racing/meetings?${qs}`);
  const list = (meetings.data && meetings.data.meetings) || [];

  for (const mtg of list) {
    if (mtg.category !== 'T') continue;

    const meetingName = mtg.name;
    console.log(`Processing meeting: ${meetingName}`);
    const meetingSlug = safeSlug(meetingName);
    const profile = {
      date,
      meeting: meetingName,
      country,
      state: mtg.state,
      track_condition: mtg.track_condition,
      rail_position: null,
      totals: { races_final: 0 },
      winners: {
        pace: { Leader: 0, Pace: 0, Midfield: 0, 'Off Midfield': 0, 'Off Pace': 0, Backmarker: 0, Unknown: 0 },
        barrier: { low: 0, mid: 0, high: 0 }
      }
    };

    for (const race of (mtg.races || [])) {
      if (race.status !== 'Final') continue;
      const evt = await fetchJson(`${BASE}/racing/events/${race.id}`);
      const r = evt.data?.race || {};
      if (!profile.rail_position) profile.rail_position = r.rail_position || null;

      const results = evt.data?.results || [];
      if (!results.length) continue;
      const winner = results.find(x => x.position === 1);
      if (!winner) continue;

      const runners = evt.data?.runners || [];
      const winRunner = runners.find(x => x.entrant_id === winner.entrant_id);
      const label = winRunner?.speedmap?.label || 'Unknown';
      profile.winners.pace[label] = (profile.winners.pace[label] || 0) + 1;

      const b = winRunner?.barrier;
      if (b !== undefined && b !== null) {
        if (b <= 4) profile.winners.barrier.low++;
        else if (b <= 9) profile.winners.barrier.mid++;
        else profile.winners.barrier.high++;
      }

      profile.totals.races_final++;

      // Optional NZ: archive loveracing public page for post‑race sectionals
      if (includeNZLoveracing && country === 'NZ') {
        const outDir = path.join(process.cwd(), 'data', 'loveracing', date, meetingSlug);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `R${String(race.race_number).padStart(2,'0')}.json`), JSON.stringify({ event_id: race.id, race: r }, null, 2));
      }
    }

    if (profile.totals.races_final > 0) {
      const outPath = path.join(process.cwd(), 'data', 'meeting_profiles', date, `${meetingSlug}.json`);
      writeJson(outPath, profile);
      console.log(`Profile saved: ${meetingName} (${profile.totals.races_final} finals)`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
