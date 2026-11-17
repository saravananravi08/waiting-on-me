#!/usr/bin/env node
'use strict';
// SessionStart hook. Registers the session, makes sure the shared refresher is running,
// refreshes if the cache is stale, and returns a short summary as additional context.
// It must never block a session from starting, so every failure ends in a quiet exit 0.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require(path.join(__dirname, 'lib', 'config.js'));
const proc = require(path.join(__dirname, 'lib', 'proc.js'));
const collect = require(path.join(__dirname, 'lib', 'collect.js'));
const render = require(path.join(__dirname, 'lib', 'render.js'));

const FRESH_MS = 60 * 1000;
const COLLECT_BUDGET_MS = 15000;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function main() {
  const input = readInput();
  const p = config.paths();
  proc.registerSession(input.session_id || `pid-${process.ppid}`, p);

  let latest = collect.readLatest(p);
  if (collect.ageMs(latest) > FRESH_MS) {
    // Fetch now, bounded, so the summary is current. On timeout we fall back to what we have.
    spawnSync(process.execPath, [path.join(__dirname, 'collect'), '--quiet'], {
      timeout: COLLECT_BUDGET_MS,
      stdio: 'ignore',
      env: process.env,
    });
    latest = collect.readLatest(p) || latest;
  }
  try {
    proc.ensureRefresher(process.env);
  } catch {
    // the summary is still useful without the refresher
  }
  if (!latest) return;

  const stale = collect.ageMs(latest) > config.intervalMinutes() * 2 * 60 * 1000;
  const context = render.summary(latest, { dashboardPath: config.dashboardUrl() ? `${config.dashboardUrl()} (file: ${p.html})` : p.html }) + (stale ? '\nNote: this data is older than expected; the refresh may have failed.' : '');
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: render.banner(latest),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    })}\n`
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`waiting-on-me: ${config.scrub(err && err.message ? err.message : err)}\n`);
}
process.exit(0);
