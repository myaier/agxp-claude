#!/usr/bin/env node
/**
 * Tests for src/advisory.ts — reads the on-disk advisory record written by the
 * agxp CLI (<HomeDir>/advisory.json). The reader must NEVER throw: an absent or
 * corrupt file yields {plugin:''} so the channel's advisory check is purely
 * best-effort. Path resolution must honor AGXP_HOME (matching the CLI's
 * config.HomeDir(): append .agxp if the value doesn't already end in it).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { advisoryFilePath, readAdvisory } from '../src/advisory.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// Each test gets its own clean AGXP_HOME so they don't trample each other or
// read the real ~/.agxp/advisory.json.
function withHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agxp-advisory-'));
    const prev = process.env.AGXP_HOME;
    process.env.AGXP_HOME = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.AGXP_HOME; else process.env.AGXP_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

console.log('\nadvisory (advisory.json reader) tests\n');

await testAsync('advisoryFilePath honors AGXP_HOME and appends .agxp suffix', withHome(async (dir) => {
  // dir does NOT end in .agxp → reader must append it (matches CLI config.HomeDir).
  const p = advisoryFilePath();
  assert.ok(p.endsWith(join('.agxp', 'advisory.json')), `expected .../.agxp/advisory.json, got ${p}`);
  assert.ok(p.startsWith(dir), `expected path under ${dir}, got ${p}`);
}));

await testAsync('advisoryFilePath does NOT double-append when AGXP_HOME already ends in .agxp', withHome(async (dir) => {
  const agxpDir = join(dir, '.agxp');
  mkdirSync(agxpDir);
  process.env.AGXP_HOME = agxpDir;
  const p = advisoryFilePath();
  assert.equal(p, join(agxpDir, 'advisory.json'));
}));

await testAsync('readAdvisory returns the plugin field for a valid file', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeFileSync(join(home, 'advisory.json'), JSON.stringify({
    client: 'available', skills: '', plugin: 'required', at: '2026-06-27T00:00:00Z',
  }));
  const rec = await readAdvisory();
  assert.equal(rec.plugin, 'required');
  assert.equal(rec.client, 'available');
}));

await testAsync('readAdvisory returns {plugin:""} when the file is absent', withHome(async () => {
  const rec = await readAdvisory();
  assert.equal(rec.plugin, '');
}));

await testAsync('readAdvisory returns {plugin:""} for corrupt JSON (never throws)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeFileSync(join(home, 'advisory.json'), '{not valid json');
  const rec = await readAdvisory();
  assert.equal(rec.plugin, '');
}));

await testAsync('readAdvisory returns {plugin:""} for a non-object JSON body', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeFileSync(join(home, 'advisory.json'), '["an","array"]');
  const rec = await readAdvisory();
  assert.equal(rec.plugin, '');
}));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
