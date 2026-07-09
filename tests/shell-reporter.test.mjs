#!/usr/bin/env node
/**
 * Tests for src/shell-reporter.ts — the timer that fires `agxp shell report`
 * unconditionally on a cadence. Mirrors advisory-checker.test.mjs: drive tick()
 * directly (no real timers) and assert the injected runReport is called and its
 * failures are swallowed. Run: bun tests/shell-reporter.test.mjs
 */
import assert from 'node:assert/strict';
import { ShellReporter } from '../src/shell-reporter.js';

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

await testAsync('tick calls runReport', async () => {
  const calls = [];
  const r = new ShellReporter({ runReport: async () => { calls.push(1); } });
  await r.tick();
  assert.equal(calls.length, 1);
});

await testAsync('tick swallows runReport rejection', async () => {
  const r = new ShellReporter({ runReport: async () => { throw new Error('boom'); } });
  await r.tick(); // must not reject
  assert.ok(true);
});

console.log(`\nshell-reporter: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
