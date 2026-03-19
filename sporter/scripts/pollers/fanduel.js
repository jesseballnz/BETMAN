#!/usr/bin/env node
const { runPoller } = require('./base_poller');
const { buildBookSnapshot, writeBookSnapshot } = require('../lib/ufc_book_builder');

const BOOK = 'fanduel';

if (process.env.SPORTER_FANDUEL_URL) {
  function transform(payload) {
    if (Array.isArray(payload.events)) return payload.events;
    if (Array.isArray(payload.leagues)) {
      const events = [];
      payload.leagues.forEach(league => {
        (league.events || []).forEach(event => {
          events.push({ ...event, league: event.league || league.name || league.code });
        });
      });
      return events;
    }
    return [];
  }

  runPoller({
    book: BOOK,
    sourceEnv: 'SPORTER_FANDUEL_URL',
    sampleFallback: 'fanduel',
    transform
  }).then(res => {
    console.log(`fanduel poll complete: ${res.count} events -> ${res.path}`);
  }).catch(err => {
    console.error('fanduel poll failed', err.message);
    process.exit(1);
  });
} else {
  buildBookSnapshot(BOOK)
    .then(snapshot => {
      const outPath = writeBookSnapshot(BOOK, snapshot);
      console.log(`fanduel poll complete: ${snapshot.events.length} events -> ${outPath}`);
    })
    .catch(err => {
      console.error('fanduel poll failed', err.message);
      process.exit(1);
    });
}
