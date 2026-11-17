#!/usr/bin/env node
'use strict';
// SessionEnd hook. Removes this session, and stops the shared refresher if no session is left.
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'lib', 'config.js'));
const proc = require(path.join(__dirname, 'lib', 'proc.js'));

try {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // no usable input
  }
  const p = config.paths();
  proc.unregisterSession(input.session_id || `pid-${process.ppid}`, p);
  if (input.session_id) require(path.join(__dirname, 'lib', 'notify.js')).forgetSession(input.session_id, p);
  if (proc.liveSessions(p) === 0) proc.stopRefresher(p);
} catch (err) {
  process.stderr.write(`waiting-on-me: ${config.scrub(err && err.message ? err.message : err)}\n`);
}
process.exit(0);
