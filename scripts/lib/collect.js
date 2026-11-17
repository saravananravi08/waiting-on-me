'use strict';
// Gathers both sources and writes latest.json, index.html and count.txt, atomically.
// Safe to call from several processes: a lock file stops two fetches running at once.
const fs = require('fs');
const config = require('./config');
const parse = require('./parse');
const render = require('./render');
const sources = require('./sources');

const LOCK_STALE_MS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readLatest(p = config.paths()) {
  try {
    const data = JSON.parse(fs.readFileSync(p.latest, 'utf8'));
    return data && Array.isArray(data.items) && data.sources ? data : null;
  } catch {
    return null;
  }
}

function ageMs(result, now = Date.now()) {
  const t = result && Date.parse(result.fetchedAt);
  return Number.isFinite(t) ? now - t : Infinity;
}

function acquireLock(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p.lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(p.lockFile).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(p.lockFile);
        else return false;
      } catch {
        // lock vanished between calls, try again
      }
    }
  }
  return false;
}

function releaseLock(p) {
  try {
    fs.unlinkSync(p.lockFile);
  } catch {
    // already gone
  }
}

async function waitForRelease(p, maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end && fs.existsSync(p.lockFile)) await sleep(250);
}

// Fetches the sources and writes the outputs. Resolves { result, skipped }.
// If another process is already fetching, waits for it (waitIfBusy) and returns its result.
// merge: fold in new Linear and Slack data but reuse the GitHub result already on disk if it
// is younger than the interval, keeping its fetched-at time, so GitHub is not asked twice
// and the refresher's schedule is unchanged.
async function refresh({ waitIfBusy = true, merge = false, env = process.env } = {}) {
  const p = config.paths(env);
  fs.mkdirSync(p.cacheDir, { recursive: true, mode: 0o700 });
  if (!acquireLock(p)) {
    if (waitIfBusy) await waitForRelease(p, 60000);
    return { result: readLatest(p), skipped: true };
  }
  try {
    const previous = merge ? readLatest(p) : null;
    const reuse =
      previous &&
      previous.sources.github &&
      previous.sources.github.status === 'ok' &&
      ageMs(previous) < config.intervalMinutes(env) * 60 * 1000;
    const [github, linear] = await Promise.all([
      reuse
        ? { ...previous.sources.github, items: previous.items.filter((i) => i.source === 'github') }
        : sources.fetchGithub(),
      sources.fetchLinear(env),
    ]);
    const slack = sources.readSlackMcp(env);
    if (slack) slack.items = await sources.settleNudges(slack.items);
    const items = parse.sortItems(parse.dedupe([...github.items, ...linear.items, ...(slack ? slack.items : [])]));
    const strip = ({ status, error, warning, parts }) => ({ status, ...(error ? { error } : {}), ...(warning ? { warning } : {}), ...(parts ? { parts } : {}) });
    const result = {
      fetchedAt: reuse ? previous.fetchedAt : new Date().toISOString(),
      intervalMinutes: config.intervalMinutes(env),
      sources: { github: strip(github), linear: strip(linear), ...(slack ? { slack: strip(slack) } : {}) },
      items,
    };
    writeAtomic(p.latest, `${JSON.stringify(result, null, 2)}\n`);
    writeAtomic(p.html, render.html(result));
    writeAtomic(p.count, `${render.countLine(result)}\n`);
    return { result, skipped: false };
  } finally {
    releaseLock(p);
  }
}

module.exports = { refresh, readLatest, ageMs, writeAtomic };
