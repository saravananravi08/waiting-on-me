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

// True only if pid is alive and is really our refresher (guards against pid reuse).
function isRefresher(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
    return args.includes('refresher.js');
  } catch {
    return false;
  }
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
  if (isRefresher(readPid(p))) return 'running';
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
  return 'started';
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
  claimPid,
  ownsPid,
  releasePid,
  ensureRefresher,
  stopRefresher,
  SESSION_MAX_AGE_MS,
};
