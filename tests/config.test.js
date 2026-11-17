'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../scripts/lib/config');

test('interval defaults to 5 minutes and is clamped to 1 to 60', () => {
  assert.equal(config.intervalMinutes({}), 5);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: '' }), 5);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: 'abc' }), 5);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: '10' }), 10);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: '0' }), 1);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: '9999' }), 60);
  assert.equal(config.intervalMinutes({ WAITING_ON_ME_INTERVAL: '7.6' }), 8);
});

test('env file parser handles export, quotes, comments and blank lines', () => {
  const out = config.parseEnvFile('# note\n\nexport LINEAR_API_KEY="abc 123"\nOTHER=\'x\'\nBARE=plain\nnot a line\n');
  assert.deepEqual(out, { LINEAR_API_KEY: 'abc 123', OTHER: 'x', BARE: 'plain' });
});

function tempPaths(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-'));
  const env = { WAITING_ON_ME_HOME: path.join(dir, 'cache'), WAITING_ON_ME_CONFIG_DIR: path.join(dir, 'cfg') };
  const p = config.paths(env);
  if (files.env !== undefined) {
    fs.mkdirSync(p.configDir, { recursive: true });
    fs.writeFileSync(p.envFile, files.env, { mode: files.mode ?? 0o600 });
    fs.chmodSync(p.envFile, files.mode ?? 0o600);
  }
  return { env, p };
}

test('linear key: environment wins over the file; neither means not configured', () => {
  const a = tempPaths({ env: 'LINEAR_API_KEY=from-file\n' });
  assert.equal(config.loadLinearKey({ ...a.env, LINEAR_API_KEY: 'from-env' }, a.p).key, 'from-env');
  assert.equal(config.loadLinearKey(a.env, a.p).key, 'from-file');
  const b = tempPaths();
  assert.equal(config.loadLinearKey(b.env, b.p).key, undefined);
});

test('linear key: a file readable by others still works but warns, without leaking the key', () => {
  const a = tempPaths({ env: 'LINEAR_API_KEY=secret-value-123\n', mode: 0o644 });
  const got = config.loadLinearKey(a.env, a.p);
  assert.equal(got.key, 'secret-value-123');
  assert.match(got.warning, /chmod 600/);
  assert.doesNotMatch(got.warning, /secret-value-123/);
});

test('scrub removes known secrets and token-shaped strings from messages', () => {
  const s = config.scrub('bad key my-secret-key and ghp_abcdefghijklmnopqrstuvwxyz0123 and lin_api_abcdefghijklmnopqrstuvwx', ['my-secret-key']);
  assert.doesNotMatch(s, /my-secret-key|ghp_|lin_api_/);
});
