'use strict';
// Paths and configuration. Nothing here prints or stores a credential.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60;

function paths(env = process.env) {
  const cacheDir = env.WAITING_ON_ME_HOME || path.join(os.homedir(), '.cache', 'waiting-on-me');
  const configDir = env.WAITING_ON_ME_CONFIG_DIR || path.join(os.homedir(), '.config', 'waiting-on-me');
  return {
    cacheDir,
    configDir,
    latest: path.join(cacheDir, 'latest.json'),
    html: path.join(cacheDir, 'index.html'),
    count: path.join(cacheDir, 'count.txt'),
    pidFile: path.join(cacheDir, 'refresher.pid'),
    lockFile: path.join(cacheDir, 'collect.lock'),
    logFile: path.join(cacheDir, 'refresher.log'),
    sessionsDir: path.join(cacheDir, 'sessions'),
    envFile: path.join(configDir, 'env'),
  };
}

// WAITING_ON_ME_INTERVAL is in minutes. 5 to 10 is sensible; 1 to 60 is accepted.
function intervalMinutes(env = process.env) {
  const raw = env.WAITING_ON_ME_INTERVAL;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
}

// Parses KEY=value lines. Accepts "export KEY=value" and single or double quotes.
function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const q = value.match(/^(["'])(.*)\1$/);
    if (q) value = q[2];
    out[m[1]] = value;
  }
  return out;
}

// Returns { key, warning }. key is undefined when none is configured.
// The environment wins over the file. The key is never logged by this module.
function loadLinearKey(env = process.env, p = paths(env)) {
  if (env.LINEAR_API_KEY && env.LINEAR_API_KEY.trim()) {
    return { key: env.LINEAR_API_KEY.trim() };
  }
  let stat;
  try {
    stat = fs.statSync(p.envFile);
  } catch {
    return {};
  }
  let warning;
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    warning = `${p.envFile} is readable by other users; run: chmod 600 ${p.envFile}`;
  }
  let text;
  try {
    text = fs.readFileSync(p.envFile, 'utf8');
  } catch {
    return { warning: `could not read ${p.envFile}` };
  }
  const key = (parseEnvFile(text).LINEAR_API_KEY || '').trim();
  return key ? { key, warning } : { warning };
}

// Removes anything that looks like a token from text that may be shown or logged.
function scrub(text, secrets = []) {
  let s = String(text);
  for (const secret of secrets) {
    if (secret) s = s.split(secret).join('[redacted]');
  }
  return s
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g, '[redacted]');
}

module.exports = {
  DEFAULT_INTERVAL_MINUTES,
  paths,
  intervalMinutes,
  parseEnvFile,
  loadLinearKey,
  scrub,
};
