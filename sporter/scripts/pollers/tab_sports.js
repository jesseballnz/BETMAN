#!/usr/bin/env node
const { runPoller } = require('./base_poller');
const { buildBookSnapshot, writeBookSnapshot } = require('../lib/ufc_book_builder');

const BOOK = 'tab_sports';

if (process.env.SPORTER_TAB_URL) {
  function transform(payload) {
    return Array.isArray(payload.events) ? payload.events : [];
  }

  runPoller({
    book: BOOK,
    sourceEnv: 'SPORTER_TAB_URL',
    sampleFallback: 'tab_sports',
    transform
  }).then(res => {
    console.log(`tab_sports poll complete: ${res.count} events -> ${res.path}`);
  }).catch(err => {
    console.error('tab_sports poll failed', err.message);
    process.exit(1);
  });
} else {
  buildBookSnapshot(BOOK)
    .then(snapshot => {
      const outPath = writeBookSnapshot(BOOK, snapshot);
      console.log(`tab_sports poll complete: ${snapshot.events.length} events -> ${outPath}`);
    })
    .catch(err => {
      console.error('tab_sports poll failed', err.message);
      process.exit(1);
    });
}
