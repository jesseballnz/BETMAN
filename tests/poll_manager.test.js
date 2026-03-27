#!/usr/bin/env node
/* Tests for scripts/poll_manager.js — PollService, PollManager, createDefaultManager */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { PollService, PollManager, createDefaultManager } = require('../scripts/poll_manager');

const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

/* silent logger to keep test output clean */
const silent = { log() {}, error() {} };

/* helper: wait ms */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ──────────────────── Synchronous PollService tests ──────────────────────── */

// 1. Constructor — valid options
{
  const svc = new PollService({
    name: 'test-svc',
    command: 'echo',
    args: ['hello'],
    intervalMs: 5000,
    log: silent
  });
  assert.strictEqual(svc.name, 'test-svc');
  assert.strictEqual(svc.command, 'echo');
  assert.deepStrictEqual(svc.args, ['hello']);
  assert.strictEqual(svc.intervalMs, 5000);
  assert.strictEqual(svc.enabled, true);
  assert.strictEqual(svc.runs, 0);
  assert.strictEqual(svc.failures, 0);
  assert.strictEqual(svc.lastSuccess, null);
  assert.strictEqual(svc.lastError, null);
  assert.strictEqual(svc._running, false);
  assert.strictEqual(svc._stopped, true);
  console.log('✓ PollService constructor sets defaults correctly');
}

// 2. Constructor — missing name throws
{
  let threw = false;
  try { new PollService({ command: 'echo', intervalMs: 1000 }); }
  catch { threw = true; }
  assert.ok(threw, 'should throw when name missing');
  console.log('✓ PollService constructor requires name');
}

// 3. Constructor — missing command AND run throws
{
  let threw = false;
  try { new PollService({ name: 'x', intervalMs: 1000 }); }
  catch { threw = true; }
  assert.ok(threw);
  console.log('✓ PollService constructor requires command or run');
}

// 4. Constructor — invalid intervalMs throws
{
  let threw = false;
  try { new PollService({ name: 'x', command: 'echo', intervalMs: -1 }); }
  catch { threw = true; }
  assert.ok(threw);
  console.log('✓ PollService constructor rejects negative intervalMs');
}

// 5. Constructor — enabled=false is respected
{
  const svc = new PollService({
    name: 'disabled',
    command: 'echo',
    intervalMs: 1000,
    enabled: false,
    log: silent
  });
  assert.strictEqual(svc.enabled, false);
  console.log('✓ PollService respects enabled=false');
}

// 6. Constructor — run function instead of command
{
  const svc = new PollService({
    name: 'fn-svc',
    run: async () => 42,
    intervalMs: 1000,
    log: silent
  });
  assert.strictEqual(svc.command, null);
  assert.strictEqual(typeof svc._runFn, 'function');
  console.log('✓ PollService accepts run function');
}

// 7. status() returns snapshot
{
  const svc = new PollService({ name: 's', command: 'echo', intervalMs: 1000, log: silent });
  const st = svc.status();
  assert.strictEqual(st.name, 's');
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.intervalMs, 1000);
  assert.strictEqual(st.runs, 0);
  assert.strictEqual(st.failures, 0);
  assert.strictEqual(st.running, false);
  console.log('✓ PollService.status() returns correct snapshot');
}

// 8. start() on disabled service is a no-op
{
  const svc = new PollService({
    name: 'nope',
    run: async () => { throw new Error('should not run'); },
    intervalMs: 1000,
    enabled: false,
    log: silent
  });
  svc.start();
  assert.strictEqual(svc._stopped, true);
  console.log('✓ PollService.start() is no-op when disabled');
}

/* ──────────────────── Synchronous PollManager tests ─────────────────────── */

// 9. Register service
{
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  const svc = mgr.register({ name: 'a', command: 'echo', intervalMs: 1000, log: silent });
  assert.ok(svc instanceof PollService);
  assert.strictEqual(mgr.services.size, 1);
  console.log('✓ PollManager.register() creates and stores service');
}

// 10. Register PollService instance directly
{
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  const svc = new PollService({ name: 'direct', command: 'echo', intervalMs: 1000, log: silent });
  const returned = mgr.register(svc);
  assert.strictEqual(returned, svc);
  console.log('✓ PollManager.register() accepts PollService instance');
}

// 11. Duplicate name throws
{
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  mgr.register({ name: 'dup', command: 'echo', intervalMs: 1000, log: silent });
  let threw = false;
  try { mgr.register({ name: 'dup', command: 'echo', intervalMs: 2000, log: silent }); }
  catch { threw = true; }
  assert.ok(threw);
  console.log('✓ PollManager rejects duplicate service names');
}

// 12. status() returns all services
{
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  mgr.register({ name: 'x', command: 'echo', intervalMs: 1000, log: silent });
  mgr.register({ name: 'y', command: 'echo', intervalMs: 2000, log: silent });
  const st = mgr.status();
  assert.strictEqual(Object.keys(st.services).length, 2);
  assert.ok('x' in st.services);
  assert.ok('y' in st.services);
  console.log('✓ PollManager.status() includes all services');
}

/* ─────────────────── Async tests — lifecycle & execution ─────────────────── */

const asyncTests = [];

// 13. PollService run function executes and tracks success
asyncTests.push((async () => {
  let count = 0;
  const svc = new PollService({
    name: 'counter',
    run: async () => { count++; },
    intervalMs: 50,
    log: silent
  });
  svc.start();
  await sleep(180);
  svc.stop();
  assert.ok(svc.runs >= 2, `expected >=2 runs, got ${svc.runs}`);
  assert.strictEqual(svc.failures, 0);
  assert.ok(svc.lastSuccess !== null);
  assert.strictEqual(svc.lastError, null);
  assert.ok(count >= 2);
  console.log(`✓ PollService executes run function repeatedly (${svc.runs} runs)`);
})());

// 14. PollService error isolation — failures are recorded, service keeps running
asyncTests.push((async () => {
  let calls = 0;
  const svc = new PollService({
    name: 'flaky',
    run: async () => { calls++; if (calls <= 2) throw new Error('boom'); },
    intervalMs: 40,
    log: silent
  });
  svc.start();
  await sleep(250);
  svc.stop();
  assert.ok(svc.failures >= 2, `expected >=2 failures, got ${svc.failures}`);
  assert.ok(svc.runs >= 1, 'should have at least 1 success after initial failures');
  assert.ok(svc.lastSuccess !== null, 'should have recovered');
  console.log(`✓ PollService isolates errors and keeps running (${svc.failures} failures, ${svc.runs} successes)`);
})());

// 15. PollService stop prevents further ticks
asyncTests.push((async () => {
  let count = 0;
  const svc = new PollService({
    name: 'stoppable',
    run: async () => { count++; },
    intervalMs: 30,
    log: silent
  });
  svc.start();
  await sleep(100);
  svc.stop();
  const afterStop = count;
  await sleep(100);
  assert.strictEqual(count, afterStop, 'no further runs after stop');
  console.log('✓ PollService.stop() prevents further execution');
})());

// 16. PollManager start/stop manages all services
asyncTests.push((async () => {
  let aCount = 0, bCount = 0;
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  mgr.register({ name: 'a', run: async () => { aCount++; }, intervalMs: 40, log: silent });
  mgr.register({ name: 'b', run: async () => { bCount++; }, intervalMs: 60, log: silent });
  mgr.start();
  assert.ok(mgr.startedAt !== null);
  await sleep(200);
  mgr.stop();
  assert.ok(aCount >= 2, `a ran ${aCount} times`);
  assert.ok(bCount >= 1, `b ran ${bCount} times`);
  console.log(`✓ PollManager.start()/stop() manages all services (a=${aCount}, b=${bCount})`);
})());

// 17. PollManager independent services — one failing doesn't stop others
asyncTests.push((async () => {
  let goodCount = 0;
  const mgr = new PollManager({ stateWriteIntervalMs: 0, log: silent });
  mgr.register({
    name: 'bad',
    run: async () => { throw new Error('always fails'); },
    intervalMs: 30,
    log: silent
  });
  mgr.register({
    name: 'good',
    run: async () => { goodCount++; },
    intervalMs: 30,
    log: silent
  });
  mgr.start();
  await sleep(200);
  mgr.stop();
  const badSvc = mgr.services.get('bad');
  const goodSvc = mgr.services.get('good');
  assert.ok(badSvc.failures >= 2, `bad should have failures (${badSvc.failures})`);
  assert.strictEqual(badSvc.runs, 0, 'bad should have 0 successes');
  assert.ok(goodSvc.runs >= 2, `good should keep running (${goodSvc.runs})`);
  assert.strictEqual(goodSvc.failures, 0);
  console.log('✓ PollManager — failing service does not affect healthy service');
})());

// 18. PollManager state persistence
asyncTests.push((async () => {
  const stateFile = path.join(TMP, 'pm-state-test.json');
  try { fs.unlinkSync(stateFile); } catch {}
  const mgr = new PollManager({ statePath: stateFile, stateWriteIntervalMs: 0, log: silent });
  mgr.register({ name: 'w', run: async () => {}, intervalMs: 50, log: silent });
  mgr.start();
  await sleep(120);
  mgr.stop();
  // stop() calls writeState()
  assert.ok(fs.existsSync(stateFile), 'state file should exist');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(state.startedAt);
  assert.ok(state.services.w);
  assert.ok(state.services.w.runs >= 1);
  console.log('✓ PollManager.writeState() persists status to disk');
})());

// 19. PollService with child process command
asyncTests.push((async () => {
  const svc = new PollService({
    name: 'echo-proc',
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    intervalMs: 60000,
    log: silent
  });
  svc.start();
  await sleep(200);
  svc.stop();
  assert.strictEqual(svc.runs, 1, 'child process should have run once');
  assert.strictEqual(svc.failures, 0);
  console.log('✓ PollService spawns child process successfully');
})());

// 20. PollService child process failure is recorded
asyncTests.push((async () => {
  const svc = new PollService({
    name: 'fail-proc',
    command: 'node',
    args: ['-e', 'process.exit(1)'],
    intervalMs: 60000,
    log: silent
  });
  svc.start();
  await sleep(200);
  svc.stop();
  assert.strictEqual(svc.runs, 0);
  assert.strictEqual(svc.failures, 1);
  assert.ok(svc.lastError !== null);
  assert.ok(svc.lastError.message.includes('exited with code 1'));
  console.log('✓ PollService records child process failure');
})());

// 21. PollService tracks lastRunDurationMs
asyncTests.push((async () => {
  const svc = new PollService({
    name: 'timed',
    run: async () => { await sleep(30); },
    intervalMs: 60000,
    log: silent
  });
  svc.start();
  await sleep(100);
  svc.stop();
  assert.ok(svc.lastRunDurationMs >= 25, `duration should be >=25ms, got ${svc.lastRunDurationMs}`);
  console.log(`✓ PollService tracks run duration (${svc.lastRunDurationMs}ms)`);
})());

// 22. PollService interval drift correction — next tick waits (interval - duration)
asyncTests.push((async () => {
  let runTimes = [];
  const svc = new PollService({
    name: 'drift-check',
    run: async () => { runTimes.push(Date.now()); },
    intervalMs: 80,
    log: silent
  });
  svc.start();
  await sleep(300);
  svc.stop();
  assert.ok(runTimes.length >= 3, `expected >=3 runs, got ${runTimes.length}`);
  // Gap between runs should be roughly intervalMs (allowing ±40ms for scheduling jitter)
  for (let i = 1; i < runTimes.length; i++) {
    const gap = runTimes[i] - runTimes[i - 1];
    assert.ok(gap >= 40, `gap ${gap}ms is too short`);
    assert.ok(gap <= 200, `gap ${gap}ms is too long`);
  }
  console.log('✓ PollService drift correction maintains interval cadence');
})());

/* ─────────────── createDefaultManager configuration tests ───────────────── */

// 23. createDefaultManager with default env values
{
  const stateFile = path.join(TMP, 'default-mgr-test.json');
  const mgr = createDefaultManager({ statePath: stateFile, stateWriteIntervalMs: 0, log: silent });
  const names = [...mgr.services.keys()];
  assert.ok(names.includes('racing-poller'), 'should have racing-poller');
  assert.ok(names.includes('status-writer'), 'should have status-writer');
  assert.ok(names.includes('cache-writer'), 'should have cache-writer');
  assert.ok(names.includes('meeting-profile-aus'), 'should have meeting-profile-aus');
  assert.ok(names.includes('meeting-profile-nz'), 'should have meeting-profile-nz');
  assert.ok(names.includes('loveracing-enrich'), 'should have loveracing-enrich');
  assert.ok(names.includes('success-tracker'), 'should have success-tracker');
  assert.ok(names.includes('fringe-report'), 'should have fringe-report');
  assert.strictEqual(mgr.services.size, 8, 'should have 8 services total');
  console.log('✓ createDefaultManager registers all 8 services');
}

// 24. Default intervals match previous jobs_runner.sh values
{
  const stateFile = path.join(TMP, 'intervals-test.json');
  const mgr = createDefaultManager({ statePath: stateFile, stateWriteIntervalMs: 0, log: silent });
  const pollMs = 60 * 1000;       // POLL_SECONDS=60
  const profileMs = 30 * 60 * 1000; // PROFILE_REFRESH_MIN=30

  assert.strictEqual(mgr.services.get('racing-poller').intervalMs, pollMs);
  assert.strictEqual(mgr.services.get('status-writer').intervalMs, pollMs);
  assert.strictEqual(mgr.services.get('cache-writer').intervalMs, pollMs);
  assert.strictEqual(mgr.services.get('success-tracker').intervalMs, pollMs);
  assert.strictEqual(mgr.services.get('fringe-report').intervalMs, pollMs);
  assert.strictEqual(mgr.services.get('meeting-profile-aus').intervalMs, profileMs);
  assert.strictEqual(mgr.services.get('meeting-profile-nz').intervalMs, profileMs);
  assert.strictEqual(mgr.services.get('loveracing-enrich').intervalMs, profileMs);
  console.log('✓ Default intervals match jobs_runner.sh values (60s poll, 30m profile)');
}

// 25. Custom interval overrides
{
  const stateFile = path.join(TMP, 'override-test.json');
  const mgr = createDefaultManager({
    pollSeconds: 30,
    profileRefreshMin: 15,
    statePath: stateFile,
    stateWriteIntervalMs: 0,
    log: silent
  });
  assert.strictEqual(mgr.services.get('racing-poller').intervalMs, 30000);
  assert.strictEqual(mgr.services.get('status-writer').intervalMs, 30000);
  assert.strictEqual(mgr.services.get('meeting-profile-aus').intervalMs, 15 * 60 * 1000);
  console.log('✓ createDefaultManager respects custom pollSeconds/profileRefreshMin');
}

// 26. Each service has correct command
{
  const stateFile = path.join(TMP, 'cmd-test.json');
  const mgr = createDefaultManager({ statePath: stateFile, stateWriteIntervalMs: 0, log: silent });
  assert.strictEqual(mgr.services.get('racing-poller').command, 'node');
  assert.strictEqual(mgr.services.get('loveracing-enrich').command, 'python3');
  assert.strictEqual(mgr.services.get('success-tracker').command, 'python3');
  assert.strictEqual(mgr.services.get('fringe-report').command, 'python3');
  assert.strictEqual(mgr.services.get('status-writer').command, 'node');
  console.log('✓ Default services use correct commands (node/python3)');
}

// 27. Racing poller has expected arguments
{
  const stateFile = path.join(TMP, 'args-test.json');
  const mgr = createDefaultManager({ statePath: stateFile, stateWriteIntervalMs: 0, log: silent });
  const args = mgr.services.get('racing-poller').args;
  assert.ok(args.includes('--countries=NZ,AUS,HK'));
  assert.ok(args.includes('--long_odds=12'));
  assert.ok(args.includes('--standout_prob=0.35'));
  assert.ok(args.includes('--ew_win_min=10'));
  console.log('✓ Racing poller carries correct default arguments');
}

/* ─────────────────── Run async tests ────────────────────────────────────── */

Promise.all(asyncTests).then(() => {
  console.log('poll_manager tests passed');
  process.exit(0);
}).catch(err => {
  console.error('poll_manager test FAILED:', err);
  process.exit(1);
});
