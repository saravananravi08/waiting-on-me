#!/usr/bin/env node
'use strict';
// The one background refresher per machine. Started by SessionStart, stopped by SessionEnd
// when no session is left. It sleeps between fetches and checks every few seconds that it
// still owns the pid file and that a session is still open.
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'lib', 'config.js'));
const proc = require(path.join(__dirname, 'lib', 'proc.js'));
const { refresh, readLatest } = require(path.join(__dirname, 'lib', 'collect.js'));

const TICK_MS = 5000;
const MIN_GAP_MS = 30000; // never fetch more often than this, even after errors
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.error(`${new Date().toISOString()} ${config.scrub(msg)}`);

async function main() {
  const p = config.paths();
  if (!proc.claimPid(p)) return; // another refresher is alive
  try {
    if (fs.statSync(p.logFile).size > 100 * 1024) fs.truncateSync(p.logFile, 0);
  } catch {
    // no log yet
  }
  const stop = () => {
    proc.releasePid(p);
    process.exit(0);
  };
  // Serve the dashboard on this machine only. If the port is taken, carry on without it.
  const port = config.dashboardPort();
  if (port) {
    try {
      await require(path.join(__dirname, 'lib', 'server.js')).start({ port, file: p.html });
    } catch (err) {
      log(`dashboard server not started on port ${port}: ${err && err.code ? err.code : err}`);
    }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let lastAttempt = 0;
  for (;;) {
    if (!proc.ownsPid(p)) return;
    if (proc.liveSessions(p) === 0) break;

    const intervalMs = config.intervalMinutes() * 60 * 1000;
    const latest = readLatest(p);
    const fetched = latest ? Date.parse(latest.fetchedAt) || 0 : 0;
    const due = Math.max(fetched + intervalMs, lastAttempt + MIN_GAP_MS);
    if (Date.now() >= due) {
      lastAttempt = Date.now();
      try {
        await refresh({ waitIfBusy: false });
      } catch (err) {
        log(`refresh failed: ${err && err.message ? err.message : err}`);
      }
    }
    await sleep(Math.min(TICK_MS, Math.max(1000, due - Date.now())));
  }
  proc.releasePid(p);
}

main().catch((err) => {
  log(`refresher crashed: ${err && err.message ? err.message : err}`);
  proc.releasePid();
  process.exit(1);
});
