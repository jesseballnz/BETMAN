const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

async function fetchJson(url){
  if (!url) throw new Error('missing_url');
  const res = await fetch(url, { headers: { 'User-Agent': 'sporter-poller/0.1' } });
  if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
  return await res.json();
}

function loadSample(book){
  const samplePath = path.join(DATA_DIR, 'sample_feeds', `${book}.json`);
  const raw = fs.readFileSync(samplePath, 'utf8');
  return JSON.parse(raw);
}

function ensureDir(dir){
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeEvent(event = {}){
  return {
    id: event.id,
    league: event.league,
    home: event.home,
    away: event.away,
    start: event.start,
    markets: {
      spread: event.lines?.spread || null,
      total: event.lines?.total || null,
      moneyline: event.lines?.moneyline || null,
      props: Array.isArray(event.lines?.props) ? event.lines.props : []
    }
  };
}

async function runPoller({ book, sourceEnv, transform = (data)=>data.events || [], sampleFallback }){
  if (!book) throw new Error('book_required');
  const url = process.env[sourceEnv];
  let payload;
  if (url) {
    payload = await fetchJson(url);
  } else {
    payload = loadSample(sampleFallback || book);
  }
  const events = transform(payload).map(normalizeEvent).filter(e => e?.id);
  const outDir = path.join(DATA_DIR, 'books');
  ensureDir(outDir);
  const result = {
    book,
    source: url || `sample:${sampleFallback || book}`,
    sourceUpdatedAt: payload.updatedAt || new Date().toISOString(),
    polledAt: new Date().toISOString(),
    events
  };
  const outPath = path.join(outDir, `${book}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return { book, count: events.length, path: outPath };
}

module.exports = {
  runPoller
};
