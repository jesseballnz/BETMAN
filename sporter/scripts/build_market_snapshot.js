#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'market_snapshot.json');
const HISTORY_PATH = path.join(process.cwd(), 'memory', 'market_history.json');
const MODEL_PATH = path.join(DATA_DIR, 'model_inputs.json');

function loadJson(filePath, fallback){
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data){
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function mean(values){
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Number((sum / values.length).toFixed(3));
}

function americanToImplied(odds){
  if (!Number.isFinite(odds)) return null;
  if (odds > 0) return Number((100 / (odds + 100)).toFixed(4));
  return Number(((-odds) / ((-odds) + 100)).toFixed(4));
}

function collectBooks(){
  if (!fs.existsSync(BOOKS_DIR)) return [];
  return fs.readdirSync(BOOKS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => loadJson(path.join(BOOKS_DIR, name), null))
    .filter(Boolean);
}

function aggregateEvents(books){
  const map = new Map();
  books.forEach(bookData => {
    (bookData.events || []).forEach(evt => {
      const key = evt.id;
      if (!map.has(key)) {
        map.set(key, {
          id: evt.id,
          league: evt.league,
          home: evt.home,
          away: evt.away,
          start: evt.start,
          books: []
        });
      }
      map.get(key).books.push({ book: bookData.book, markets: evt.markets || {} });
    });
  });
  return [...map.values()];
}

function computeConsensus(event){
  const spreadLines = event.books
    .map(b => Number(b.markets?.spread?.home))
    .filter(Number.isFinite);
  const totalLines = event.books
    .map(b => Number(b.markets?.total?.line))
    .filter(Number.isFinite);
  const moneylines = event.books
    .map(b => ({
      book: b.book,
      home: americanToImplied(Number(b.markets?.moneyline?.home)),
      away: americanToImplied(Number(b.markets?.moneyline?.away))
    }))
    .filter(x => Number.isFinite(x.home) && Number.isFinite(x.away));

  const consensus = {
    spread: spreadLines.length ? mean(spreadLines) : null,
    total: totalLines.length ? mean(totalLines) : null,
    moneylineHomeProb: moneylines.length ? mean(moneylines.map(x => x.home)) : null,
    moneylineAwayProb: moneylines.length ? mean(moneylines.map(x => x.away)) : null
  };
  return consensus;
}

function computeEdges(event, consensus, model){
  event.books = event.books.map(entry => {
    const spreadEdge = (Number.isFinite(consensus.spread) && Number.isFinite(entry.markets?.spread?.home))
      ? Number((consensus.spread - entry.markets.spread.home).toFixed(3))
      : null;
    const totalEdge = (Number.isFinite(consensus.total) && Number.isFinite(entry.markets?.total?.line))
      ? Number((consensus.total - entry.markets.total.line).toFixed(3))
      : null;
    const homeProb = americanToImplied(Number(entry.markets?.moneyline?.home));
    const awayProb = americanToImplied(Number(entry.markets?.moneyline?.away));
    const moneylineEdge = (Number.isFinite(consensus.moneylineHomeProb) && Number.isFinite(homeProb))
      ? Number((consensus.moneylineHomeProb - homeProb).toFixed(4))
      : null;
    const props = Array.isArray(entry.markets?.props)
      ? entry.markets.props.slice(0, 8)
      : [];
    const propsCount = Array.isArray(entry.markets?.props) ? entry.markets.props.length : 0;
    const modelEdges = model ? {
      spread: (Number.isFinite(model.spread) && Number.isFinite(entry.markets?.spread?.home))
        ? Number((model.spread - entry.markets.spread.home).toFixed(3))
        : null,
      total: (Number.isFinite(model.total) && Number.isFinite(entry.markets?.total?.line))
        ? Number((model.total - entry.markets.total.line).toFixed(3))
        : null,
      moneyline: (Number.isFinite(model.moneylineHomeProb) && Number.isFinite(homeProb))
        ? Number((model.moneylineHomeProb - homeProb).toFixed(4))
        : null
    } : { spread: null, total: null, moneyline: null };
    return {
      book: entry.book,
      spread: entry.markets.spread || null,
      total: entry.markets.total || null,
      moneyline: entry.markets.moneyline || null,
      props,
      propsCount,
      edges: { spread: spreadEdge, total: totalEdge, moneyline: moneylineEdge },
      modelEdges
    };
  });
}

function computeMoves(events, previousMap){
  events.forEach(evt => {
    const prev = previousMap.get(evt.id);
    if (!prev) {
      evt.moves = { spread: null, total: null };
      return;
    }
    evt.moves = {
      spread: Number.isFinite(evt.consensus.spread) && Number.isFinite(prev.spread)
        ? Number((evt.consensus.spread - prev.spread).toFixed(3))
        : null,
      total: Number.isFinite(evt.consensus.total) && Number.isFinite(prev.total)
        ? Number((evt.consensus.total - prev.total).toFixed(3))
        : null
    };
  });
}

async function main(){
  const books = collectBooks();
  if (!books.length) {
    console.error('No book data found. Run pollers first.');
    process.exit(1);
  }
  const events = aggregateEvents(books);
  const modelData = loadJson(MODEL_PATH, { models: [] });
  const modelMap = new Map();
  (modelData.models || []).forEach(entry => {
    if (entry && entry.id) modelMap.set(entry.id, entry);
  });
  const modelUpdatedAt = modelData.updatedAt || null;
  const prevSnapshot = loadJson(SNAPSHOT_PATH, null);
  const prevMap = new Map();
  if (prevSnapshot) {
    (prevSnapshot.events || []).forEach(evt => {
      prevMap.set(evt.id, { spread: evt.consensus?.spread, total: evt.consensus?.total });
    });
  }

  events.forEach(evt => {
    evt.consensus = computeConsensus(evt);
    const model = modelMap.get(evt.id) || null;
    if (model) {
      evt.model = {
        spread: Number.isFinite(model.spread) ? model.spread : null,
        total: Number.isFinite(model.total) ? model.total : null,
        moneylineHomeProb: Number.isFinite(model.moneylineHomeProb) ? model.moneylineHomeProb : null,
        moneylineAwayProb: Number.isFinite(model.moneylineAwayProb) ? model.moneylineAwayProb : null,
        updatedAt: modelUpdatedAt
      };
    } else {
      evt.model = null;
    }
    if (evt.model) {
      evt.modelEdge = {
        spread: Number.isFinite(evt.model.spread) && Number.isFinite(evt.consensus.spread)
          ? Number((evt.model.spread - evt.consensus.spread).toFixed(3))
          : null,
        total: Number.isFinite(evt.model.total) && Number.isFinite(evt.consensus.total)
          ? Number((evt.model.total - evt.consensus.total).toFixed(3))
          : null,
        moneylineHomeProb: Number.isFinite(evt.model.moneylineHomeProb) && Number.isFinite(evt.consensus.moneylineHomeProb)
          ? Number((evt.model.moneylineHomeProb - evt.consensus.moneylineHomeProb).toFixed(4))
          : null
      };
    } else {
      evt.modelEdge = { spread: null, total: null, moneylineHomeProb: null };
    }
    computeEdges(evt, evt.consensus, evt.model);
    evt.propsAvailable = evt.books.reduce((sum, b) => sum + (b.propsCount || 0), 0);
  });
  computeMoves(events, prevMap);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    books: books.map(b => ({ book: b.book, count: (b.events || []).length, polledAt: b.polledAt })),
    events
  };
  writeJson(SNAPSHOT_PATH, snapshot);

  const history = loadJson(HISTORY_PATH, []);
  history.unshift({
    generatedAt: snapshot.generatedAt,
    events: snapshot.events.map(evt => ({ id: evt.id, spread: evt.consensus.spread, total: evt.consensus.total }))
  });
  while (history.length > 20) history.pop();
  writeJson(HISTORY_PATH, history);
  console.log(`Market snapshot built: ${events.length} events -> ${SNAPSHOT_PATH}`);
}

main().catch(err => {
  console.error('Market snapshot failed', err);
  process.exit(1);
});
