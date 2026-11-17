'use strict';
// No live calls: Linear is exercised through an injected fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fetchLinear } = require('../scripts/lib/sources');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'linear-response.json'), 'utf8'));
const KEY = 'lin_api_FAKEKEYFORTESTSONLY1234567890';
const env = { LINEAR_API_KEY: KEY, WAITING_ON_ME_CONFIG_DIR: '/nonexistent', WAITING_ON_ME_HOME: '/nonexistent' };
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('no key: not configured, and the fetch is never attempted', async () => {
  let called = false;
  const got = await fetchLinear({ WAITING_ON_ME_CONFIG_DIR: '/nonexistent', WAITING_ON_ME_HOME: '/nonexistent' }, async () => { called = true; });
  assert.equal(got.status, 'not-configured');
  assert.equal(called, false);
  assert.match(got.error, /Linear is not configured/);
});

test('success: parses items and sends the key as the Authorization header only', async () => {
  let seen;
  const got = await fetchLinear(env, async (url, opts) => {
    seen = { url, opts };
    return { status: 200, ok: true, json: async () => fixture };
  });
  assert.equal(got.status, 'ok');
  assert.equal(got.items.length, 4);
  assert.equal(seen.url, 'https://api.linear.app/graphql');
  assert.equal(seen.opts.headers.Authorization, KEY);
  assert.doesNotMatch(seen.opts.body, new RegExp(KEY), 'the key must not be in the body');
});

test('401 is a clear failure and the key never appears in the message', async () => {
  const got = await fetchLinear(env, reply(401, {}));
  assert.equal(got.status, 'failed');
  assert.match(got.error, /rejected the API key/);
  assert.equal(JSON.stringify(got).includes(KEY), false);
});

test('GraphQL errors are surfaced, with the key scrubbed if echoed back', async () => {
  const got = await fetchLinear(env, reply(200, { errors: [{ message: `bad field near ${KEY}` }] }));
  assert.equal(got.status, 'failed');
  assert.match(got.error, /Linear error/);
  assert.equal(JSON.stringify(got).includes(KEY), false);
});

test('network errors and timeouts fail the source with a reason, never throw', async () => {
  const boom = await fetchLinear(env, async () => { throw new Error(`connect ECONNREFUSED using ${KEY}`); });
  assert.equal(boom.status, 'failed');
  assert.equal(JSON.stringify(boom).includes(KEY), false);
  const timeout = await fetchLinear(env, async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
  assert.equal(timeout.error, 'Linear timed out');
});

test('a non-JSON response is a failure, not an empty success', async () => {
  const got = await fetchLinear(env, async () => ({ status: 502, ok: false, json: async () => { throw new Error('x'); } }));
  assert.equal(got.status, 'failed');
  assert.match(got.error, /HTTP 502/);
});
