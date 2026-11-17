'use strict';
// Session tracking and the single shared background refresher.
//
// Every Claude Code session writes a small file under sessions/ at SessionStart and
// removes it at SessionEnd. One refresher per machine runs while at least one such file
// exists. Its pid file is created exclusively, so concurrent starts cannot make two.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');

// A session that never reported its end (a crash) stops counting after this long.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REFRESHER_SCRIPT = path.join(__dirname, '..', 'refresher.js');

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'unknown';
}

function registerSession(id, p = config.paths()) {
  fs.mkdirSync(p.sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(p.sessionsDir, safeId(id)), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

function unregisterSession(id, p = config.paths()) {
  try {
    fs.unlinkSync(path.join(p.sessionsDir, safeId(id)));
  } catch {
    // already gone
  }
}

// Drops stale session files and returns how many sessions are left.
function liveSessions(p = config.paths(), now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(p.sessionsDir);
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const file = path.join(p.sessionsDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) fs.unlinkSync(file);
      else live += 1;
    } catch {
      // raced with another process
    }
  }
  return live;
}

function readPid(p = config.paths()) {
  try {
    const n = parseInt(fs.readFileSync(p.pidFile, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// The command line of a live process, or '' if it is gone.
function processArgs(pid) {
  if (!pid) return '';
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return '';
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return '';
  }
}

// True only if pid is alive and is really a refresher (guards against pid reuse).
function isRefresher(pid) {
  return processArgs(pid).includes('refresher.js');
}

// True if the running refresher is this copy of the plugin, not an older installed version.
function isThisVersion(pid) {
  return processArgs(pid).includes(REFRESHER_SCRIPT);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Called by the refresher itself on start. True if it now owns the pid file.
function claimPid(p = config.paths()) {
  fs.mkdirSync(p.cacheDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(p.pidFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const other = readPid(p);
      if (other && other !== process.pid && isRefresher(other)) return false;
      try {
        fs.unlinkSync(p.pidFile);
      } catch {
        // someone else removed it
      }
    }
  }
  return false;
}

function ownsPid(p = config.paths()) {
  return readPid(p) === process.pid;
}

function releasePid(p = config.paths()) {
  if (ownsPid(p)) {
    try {
      fs.unlinkSync(p.pidFile);
    } catch {
      // already gone
    }
  }
}

// Starts the refresher unless one is already running. Returns 'running' or 'started'.
function ensureRefresher(env = process.env) {
  const p = config.paths(env);
  const pid = readPid(p);
  let outcome = 'started';
  if (isRefresher(pid)) {
    if (isThisVersion(pid)) return 'running';
    // A refresher from an older version of the plugin is still going, and would keep
    // rebuilding the data with old rules. Stop it and start this version.
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && processArgs(pid); i++) sleepSync(100);
    outcome = 'replaced';
  }
  fs.mkdirSync(p.cacheDir, { recursive: true, mode: 0o700 });
  let out = 'ignore';
  try {
    out = fs.openSync(p.logFile, 'a', 0o600);
  } catch {
    // log is optional
  }
  const child = spawn(process.execPath, [REFRESHER_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.unref();
  return outcome;
}

// Stops the refresher if it is running. Returns true if a signal was sent.
function stopRefresher(p = config.paths()) {
  const pid = readPid(p);
  if (!isRefresher(pid)) {
    try {
      fs.unlinkSync(p.pidFile);
    } catch {
      // nothing to clean
    }
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  safeId,
  registerSession,
  unregisterSession,
  liveSessions,
  readPid,
  isRefresher,
  isThisVersion,
  claimPid,
  ownsPid,
  releasePid,
  ensureRefresher,
  stopRefresher,
  SESSION_MAX_AGE_MS,
};
