#!/usr/bin/env node
'use strict';
// Stop and UserPromptSubmit hook. Usage: notify.js stop | prompt
// Tells the session about nudges it has not seen yet, once each. It must never get in the
// way: every failure ends in a quiet exit 0 with no output.
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'lib', 'config.js'));
const collect = require(path.join(__dirname, 'lib', 'collect.js'));
const notify = require(path.join(__dirname, 'lib', 'notify.js'));

try {
  const mode = process.argv[2];
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // no usable input
  }
  // A Stop hook that has already made Claude continue must not do so again.
  if (!(mode === 'stop' && input.stop_hook_active) && input.session_id) {
    const p = config.paths();
    const latest = collect.readLatest(p);
    const fresh = collect.ageMs(latest) < Math.max(15, config.intervalMinutes() * 3) * 60 * 1000;
    const nudges = fresh ? notify.newNudges(latest, notify.readSeen(input.session_id, p)) : [];
    if (nudges.length > 0) {
      notify.markSeen(input.session_id, nudges.map((n) => n.url), p);
      process.stdout.write(`${JSON.stringify(mode === 'stop' ? notify.stopOutput(nudges) : notify.promptOutput(nudges))}\n`);
    }
  }
} catch (err) {
  process.stderr.write(`waiting-on-me: ${config.scrub(err && err.message ? err.message : err)}\n`);
}
process.exit(0);
