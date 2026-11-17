#!/usr/bin/env node
'use strict';
// Backs the /waiting command: refreshes now, then prints the table.
// Usage: waiting.js [--no-refresh]
const path = require('path');
const config = require(path.join(__dirname, 'lib', 'config.js'));
const collect = require(path.join(__dirname, 'lib', 'collect.js'));
const render = require(path.join(__dirname, 'lib', 'render.js'));

async function main() {
  const p = config.paths();
  let result;
  if (process.argv.includes('--no-refresh')) result = collect.readLatest(p);
  else result = (await collect.refresh({ waitIfBusy: true })).result || collect.readLatest(p);
  if (!result) {
    console.log('Nothing could be fetched and there is no earlier result. Run: node scripts/collect --json for details.');
    return;
  }
  console.log(render.table(result, { dashboardPath: p.html }));
}

main().catch((err) => {
  console.log(`waiting-on-me failed: ${config.scrub(err && err.message ? err.message : err)}`);
});
