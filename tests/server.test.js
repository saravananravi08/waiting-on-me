'use strict';
// The dashboard server: this machine only, one page only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../scripts/lib/server');
const config = require('../scripts/lib/config');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-srv-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(path.join(dir, 'latest.json'), '{"secret":"data"}');
  const s = await server.start({ port: 0, file });
  try {
    await fn(`http://127.0.0.1:${s.address().port}`, file, s);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

test('serves the page at / with no caching, and only on 127.0.0.1', async () => {
  await withServer(async (base, file, s) => {
    assert.equal(s.address().address, '127.0.0.1');
    fs.writeFileSync(file, '<!doctype html><title>one</title>');
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /one/);
    fs.writeFileSync(file, '<!doctype html><title>two</title>');
    assert.match(await (await fetch(`${base}/index.html`)).text(), /two/, 'each request reads the current file');
  });
});

test('nothing else in the folder is reachable, and writes are refused', async () => {
  await withServer(async (base, file) => {
    fs.writeFileSync(file, 'x');
    for (const p of ['/latest.json', '/linear-mcp.json', '/sessions/', '/index.html/..%2flatest.json', '/%2e%2e/latest.json']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    assert.equal((await fetch(`${base}/`, { method: 'POST', body: 'x' })).status, 405);
  });
});

test('before the first build it answers 503, not a crash', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 503);
  });
});

test('port: default 8787, can be changed or turned off, bad values fall back', () => {
  assert.equal(config.dashboardPort({}), 8787);
  assert.equal(config.dashboardPort({ WAITING_ON_ME_PORT: '9001' }), 9001);
  assert.equal(config.dashboardPort({ WAITING_ON_ME_PORT: 'off' }), null);
  assert.equal(config.dashboardPort({ WAITING_ON_ME_PORT: '0' }), null);
  assert.equal(config.dashboardPort({ WAITING_ON_ME_PORT: '80' }), 8787);
  assert.equal(config.dashboardPort({ WAITING_ON_ME_PORT: 'abc' }), 8787);
  assert.equal(config.dashboardUrl({ WAITING_ON_ME_PORT: '9001' }), 'http://127.0.0.1:9001/');
  assert.equal(config.dashboardUrl({ WAITING_ON_ME_PORT: 'off' }), null);
});
