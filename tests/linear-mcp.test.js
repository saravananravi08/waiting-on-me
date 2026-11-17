'use strict';
// Linear through Claude's own MCP connection. No live calls, no session needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parse = require('../scripts/lib/parse');
const sources = require('../scripts/lib/sources');

const read = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const record = (over = {}) => ({
  fetchedAt: new Date().toISOString(),
  server: 'plugin_spec_linear',
  issues: { text: read('linear-mcp-issues.json') },
  notifications: { text: read('linear-mcp-notifications.json') },
  ...over,
});

test('issues: only Backlog and Todo are kept; in build, in review and done are dropped', () => {
  const items = parse.parseLinearMcp(record()).filter((i) => i.kind === 'assigned');
  assert.deepEqual(items.map((i) => i.ref), ['EX-33', 'EX-34']);
  assert.equal(items[0].who, 'Jo Example');
  assert.equal(items[1].who, 'unknown');
  assert.equal(items[0].since, '2026-11-17T10:00:00.000Z');
});

test('issues: the two lists the session stores are read together, and one failing is an error', () => {
  const text = read('linear-mcp-issues.json');
  const both = parse.parseLinearMcp({ notifications: { text: '{"notifications":[]}' }, issueLists: [{ text }, { text: '{"issues":[]}' }] });
  assert.deepEqual(both.map((i) => i.ref), ['EX-33', 'EX-34']);
  assert.throws(() => parse.parseLinearMcp({ issueLists: [{ text }, { error: 'tool failed' }] }), /list_issues: tool failed/);
});

test('notifications: unread mentions only, the sender is read from the subtitle', () => {
  const items = parse.parseLinearMcp(record()).filter((i) => i.kind === 'mention');
  assert.deepEqual(items.map((i) => i.ref), ['EX-40', 'EX-41', 'EX-44', '']);
  assert.deepEqual(items.map((i) => i.who), ['Jo Example', 'jo@example.com', 'Sam Example', 'unknown']);
  assert.equal(items[0].url, 'https://linear.app/example/issue/EX-40/plan-the-launch#comment-1');
});

test('an error stored by the session surfaces as an error, not as an empty list', () => {
  assert.throws(() => parse.parseLinearMcp(record({ issues: { error: 'tool failed' } })), /list_issues: tool failed/);
  assert.throws(() => parse.parseLinearMcp(record({ notifications: { text: 'not json' } })), /not JSON/);
});

function envWith(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-mcp-'));
  const env = { WAITING_ON_ME_HOME: path.join(dir, 'cache'), WAITING_ON_ME_CONFIG_DIR: path.join(dir, 'cfg') };
  if (file !== undefined) {
    fs.mkdirSync(env.WAITING_ON_ME_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.WAITING_ON_ME_HOME, 'linear-mcp.json'), JSON.stringify(file));
  }
  return env;
}

test('readLinearMcp: absent file is null; fresh file gives items; stale file is ignored', () => {
  assert.equal(sources.readLinearMcp(envWith(undefined)), null);
  const fresh = sources.readLinearMcp(envWith(record()));
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.items.length, 6);
  const old = record({ fetchedAt: '2020-01-01T00:00:00Z' });
  const env = envWith(old);
  const file = path.join(env.WAITING_ON_ME_HOME, 'linear-mcp.json');
  fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(sources.readLinearMcp(env), null);
});

test('readLinearMcp: a stored session error is reported as a failed source', () => {
  const got = sources.readLinearMcp(envWith({ fetchedAt: new Date().toISOString(), error: 'no Linear MCP server is connected to this session' }));
  assert.equal(got.status, 'failed');
  assert.match(got.error, /no Linear MCP server is connected/);
});

test('fetchLinear: Claude data wins and the API is never called; without it, an API key is used', async () => {
  let called = 0;
  const fake = async () => { called++; return { status: 401, ok: false, json: async () => ({}) }; };
  const viaClaude = await sources.fetchLinear(envWith(record()), fake);
  assert.equal(viaClaude.status, 'ok');
  assert.equal(called, 0);
  const env = { ...envWith(undefined), LINEAR_API_KEY: 'lin_api_FAKEFORTESTSONLY123456789012' };
  const viaKey = await sources.fetchLinear(env, fake);
  assert.equal(called, 1);
  assert.equal(viaKey.status, 'failed');
});

test('fetchLinear: Claude reported an error and there is no key, so the error is shown, not "not configured"', async () => {
  const got = await sources.fetchLinear(envWith({ fetchedAt: new Date().toISOString(), error: 'no Linear MCP server is connected to this session' }), async () => {});
  assert.equal(got.status, 'failed');
  assert.match(got.error, /Linear through Claude/);
});
