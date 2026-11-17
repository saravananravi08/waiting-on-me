'use strict';
// Serves the dashboard page on this machine only (127.0.0.1). Nothing else in the cache
// folder is reachable: every path other than / answers 404. It runs inside the shared
// refresher, so it starts with the first session and stops with the last.
const fs = require('fs');
const http = require('http');

const HOST = '127.0.0.1';

function start({ port, file }) {
  const server = http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    if (path !== '/' && path !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found\n');
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '10' });
        return res.end('The dashboard has not been built yet. Try again shortly.\n');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

module.exports = { start, HOST };
