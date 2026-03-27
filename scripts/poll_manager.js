#!/usr/bin/env node
/* Standalone poll manager — replaces bash loop orchestration with independent
   Node.js service management.  Each registered PollService runs on its own
   timer, isolated from other services, and reports lifecycle state.

   Usage:
     node scripts/poll_manager.js            # start all default services
     POLL_SECONDS=30 node scripts/poll_manager.js  # override racing poll interval

   Environment configuration (defaults match previous jobs_runner.sh values):
     POLL_SECONDS           – base racing‑poll interval in seconds  (default 60)
     PROFILE_REFRESH_MIN    – meeting‑profile refresh in minutes    (default 30)
     STATE_WRITE_INTERVAL   – how often to persist state in seconds (default 15)
*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(ROOT, 'memory', 'poll-manager-state.json');

/* ────────────────────────────── PollService ─────────────────────────────── */

class PollService {
  /**
   * @param {object} opts
   * @param {string}            opts.name        – unique service identifier
   * @param {string}            opts.command      – executable (e.g. 'node', 'python3')
   * @param {string[]}          opts.args         – arguments for the command
   * @param {number}            opts.intervalMs   – milliseconds between runs
   * @param {boolean}           [opts.enabled]    – whether the service is active (default true)
   * @param {string}            [opts.cwd]        – working directory (default ROOT)
   * @param {Function}          [opts.run]        – optional async function instead of spawning a process
   * @param {Function}          [opts.log]        – optional logger (default console)
   */
  constructor(opts = {}) {
    if (!opts.name) throw new Error('PollService requires a name');
    if (!opts.run && !opts.command) throw new Error('PollService requires a command or run function');
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error('PollService requires a positive intervalMs');
    }

    this.name = opts.name;
    this.command = opts.command || null;
    this.args = opts.args || [];
    this.intervalMs = opts.intervalMs;
    this.enabled = opts.enabled !== false;
    this.cwd = opts.cwd || ROOT;
    this._runFn = opts.run || null;
    this._log = opts.log || console;

    // Lifecycle state
    this.runs = 0;
    this.failures = 0;
    this.lastSuccess = null;
    this.lastError = null;
    this.lastRunDurationMs = 0;

    // Internal
    this._timer = null;
    this._running = false;
    this._stopped = true;
  }

  /* Execute one tick — either call the run function or spawn a child process */
  async _execute() {
    if (this._runFn) return this._runFn();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: 'inherit'
      });
      child.on('error', reject);
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`${this.name} exited with code ${code}`));
      });
    });
  }

  /* Single poll cycle — run, record, schedule next */
  async _tick() {
    if (this._stopped) return;
    this._running = true;
    const started = Date.now();
    try {
      await this._execute();
      this.runs += 1;
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.failures += 1;
      this.lastError = { message: err.message, at: new Date().toISOString() };
      this._log.error(`[poll_manager] ${this.name} error:`, err.message);
    }
    this.lastRunDurationMs = Date.now() - started;
    this._running = false;

    if (!this._stopped) {
      // For production intervals (≥1 s) enforce a 1 s floor between ticks to
      // avoid busy-looping when a task consumes most of its interval.  Short
      // intervals (used in tests) skip the floor.
      const floor = this.intervalMs < 1000 ? 0 : 1000;
      const wait = Math.max(floor, this.intervalMs - this.lastRunDurationMs);
      this._timer = setTimeout(() => this._tick(), wait);
    }
  }

  start() {
    if (!this.enabled) return;
    this._stopped = false;
    this._tick();
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  status() {
    return {
      name: this.name,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      runs: this.runs,
      failures: this.failures,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      lastRunDurationMs: this.lastRunDurationMs,
      running: this._running
    };
  }
}

/* ────────────────────────────── PollManager ─────────────────────────────── */

class PollManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath]          – where to persist state JSON
   * @param {number} [opts.stateWriteIntervalMs] – how often to auto-save state (0 to disable)
   * @param {Function} [opts.log]              – optional logger
   */
  constructor(opts = {}) {
    this.services = new Map();
    this.startedAt = null;
    this.statePath = opts.statePath || DEFAULT_STATE_PATH;
    this.stateWriteIntervalMs = opts.stateWriteIntervalMs != null
      ? opts.stateWriteIntervalMs
      : 15000;
    this._log = opts.log || console;
    this._stateTimer = null;
  }

  /**
   * Register a PollService (or create one from a plain object).
   * Returns the registered PollService instance.
   */
  register(opts) {
    const svc = opts instanceof PollService ? opts : new PollService(opts);
    if (this.services.has(svc.name)) {
      throw new Error(`Service "${svc.name}" is already registered`);
    }
    this.services.set(svc.name, svc);
    return svc;
  }

  /** Start all enabled services and begin periodic state writes. */
  start() {
    this.startedAt = new Date().toISOString();
    this._log.log(`[poll_manager] starting ${this.services.size} services`);
    for (const svc of this.services.values()) {
      if (svc.enabled) {
        this._log.log(`[poll_manager]   ▸ ${svc.name} every ${svc.intervalMs}ms`);
      }
      svc.start();
    }
    this.writeState();
    if (this.stateWriteIntervalMs > 0) {
      this._stateTimer = setInterval(() => this.writeState(), this.stateWriteIntervalMs);
    }
  }

  /** Stop all services and final state write. */
  stop() {
    for (const svc of this.services.values()) {
      svc.stop();
    }
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    this.writeState();
    this._log.log('[poll_manager] stopped');
  }

  /** Snapshot of every service's current status. */
  status() {
    const services = {};
    for (const [name, svc] of this.services) {
      services[name] = svc.status();
    }
    return { startedAt: this.startedAt, services };
  }

  /** Persist current status to disk. */
  writeState() {
    try {
      const data = this.status();
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch (err) {
      this._log.error('[poll_manager] state write failed:', err.message);
    }
  }
}

/* ──────────────────── Default service configuration ─────────────────────── */

/**
 * Create a PollManager pre-loaded with the production services.
 * All intervals are configurable via environment variables, with defaults
 * matching the previous jobs_runner.sh / adaptive_poller_loop.sh values.
 *
 * @param {object} [overrides]             – env-style overrides for testing
 * @param {number} [overrides.pollSeconds] – base racing interval (default 60)
 * @param {number} [overrides.profileRefreshMin] – profile refresh (default 30)
 * @param {string} [overrides.statePath]   – state file path
 * @param {number} [overrides.stateWriteIntervalMs] – state write cadence
 * @param {Function} [overrides.log]       – logger
 */
function createDefaultManager(overrides = {}) {
  const pollSeconds = overrides.pollSeconds
    ?? Number(process.env.POLL_SECONDS || 60);
  const profileRefreshMin = overrides.profileRefreshMin
    ?? Number(process.env.PROFILE_REFRESH_MIN || 30);

  const pollMs = pollSeconds * 1000;
  const profileMs = profileRefreshMin * 60 * 1000;

  const manager = new PollManager({
    statePath: overrides.statePath,
    stateWriteIntervalMs: overrides.stateWriteIntervalMs,
    log: overrides.log
  });

  /* ── Meeting profiles (every PROFILE_REFRESH_MIN, default 30 min) ───── */

  manager.register({
    name: 'meeting-profile-aus',
    command: 'node',
    args: ['scripts/meeting_profile.js', '--date=today', '--country=AUS'],
    intervalMs: profileMs,
    log: overrides.log
  });

  manager.register({
    name: 'meeting-profile-nz',
    command: 'node',
    args: ['scripts/meeting_profile.js', '--date=today', '--country=NZ', '--loveracing=true'],
    intervalMs: profileMs,
    log: overrides.log
  });

  manager.register({
    name: 'loveracing-enrich',
    command: 'python3',
    args: ['scripts/loveracing_enrich.py'],
    intervalMs: profileMs,
    log: overrides.log
  });

  /* ── Core racing poll cycle (every POLL_SECONDS, default 60 s) ──────── */

  manager.register({
    name: 'racing-poller',
    command: 'node',
    args: [
      'scripts/racing_poller.js',
      '--countries=NZ,AUS,HK',
      '--status=', '--meetings=',
      '--long_odds=12',
      '--recent_window=3', '--recent_top3=2',
      '--standout_prob=0.35', '--standout_ratio=1.8',
      '--split_top1=0.6',
      '--ew_win_min=10', '--ew_place_min=3'
    ],
    intervalMs: pollMs,
    log: overrides.log
  });

  manager.register({
    name: 'status-writer',
    command: 'node',
    args: ['scripts/status_writer.js'],
    intervalMs: pollMs,
    log: overrides.log
  });

  manager.register({
    name: 'cache-writer',
    command: 'node',
    args: ['scripts/race_cache_writer.js'],
    intervalMs: pollMs,
    log: overrides.log
  });

  manager.register({
    name: 'success-tracker',
    command: 'python3',
    args: ['scripts/success_tracker.py'],
    intervalMs: pollMs,
    log: overrides.log
  });

  manager.register({
    name: 'fringe-report',
    command: 'python3',
    args: ['scripts/fringe_threshold_report.py'],
    intervalMs: pollMs,
    log: overrides.log
  });

  return manager;
}

/* ──────────────────────── Standalone entry point ────────────────────────── */

if (require.main === module) {
  const manager = createDefaultManager();
  const shutdown = () => {
    manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  manager.start();
  console.log('[poll_manager] running — press Ctrl-C to stop');
}

/* ──────────────────────────── Exports ───────────────────────────────────── */

module.exports = { PollService, PollManager, createDefaultManager };
