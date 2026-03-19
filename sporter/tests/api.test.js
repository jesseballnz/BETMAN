import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 9091;
let server;

async function runScript(script){
  await new Promise((resolve, reject) => {
    const child = spawn('node', [script], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code}`));
    });
  });
}

async function startServer(){
  server = spawn('node', ['scripts/sporter_server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 3000);
    const onData = data => {
      if (String(data).includes('Sportr server listening')) {
        clearTimeout(timer);
        server.stdout.off('data', onData);
        resolve();
      }
    };
    server.on('error', reject);
    server.stdout.on('data', onData);
  });
}

function stopServer(){
  if (server && !server.killed) {
    server.kill();
  }
}

test.before(async () => {
  await runScript('scripts/run_market_pipeline.js');
  await startServer();
  await delay(100); // give the server a tick
});

test.after(() => {
  stopServer();
});

test('health endpoint reports ok', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'sportr-api');
});

test('schedule endpoint returns leagues and events', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/schedule`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.leagues));
  assert.ok(body.leagues.length > 0, 'expected at least one league');
  const leagueWithEvents = body.leagues.find(lg => Array.isArray(lg.events) && lg.events.length);
  assert.ok(leagueWithEvents, 'expected a league with events');
});

test('market endpoint includes UFC event with props from books', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/market`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.events));
  assert.ok(body.events.length >= 3, 'expected multiple events');
  const ufc = body.events.find(evt => evt.league === 'UFC');
  assert.ok(ufc, 'UFC event missing from snapshot');
  assert.ok(Array.isArray(ufc.books));
  const bookWithProps = ufc.books.find(book => Array.isArray(book.props) && book.props.length > 0);
  assert.ok(bookWithProps, 'UFC props not attached to book entries');
});

test('market events expose consensus and edges', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/market`);
  const body = await res.json();
  const event = body.events.find(evt => evt.books && evt.books.length);
  assert.ok(event, 'no events with books');
  assert.ok(typeof event.consensus === 'object' && event.consensus !== null, 'consensus missing');
  const book = event.books[0];
  assert.ok(book.edges, 'edges missing on book entry');
});
