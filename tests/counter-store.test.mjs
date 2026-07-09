#!/usr/bin/env node
/**
 * Tests for src/counter-store.ts — the durable, monotonic, best-effort counter
 * store the shell increments and `agxp shell report` reads. Run:
 *   node tests/counter-store.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CounterStore } from '../src/counter-store.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'agxp-counters-'));
  return { home, store: new CounterStore('agxp', home) };
}
function readFile(home) {
  return JSON.parse(readFileSync(join(home, 'instances', 'agxp', 'counters.json'), 'utf8'));
}

test('incr accumulates monotonically', () => {
  const { home, store } = fresh();
  store.incr('poll_auto');
  store.incr('poll_auto');
  store.incr('deliver_ok', 3);
  const f = readFile(home);
  assert.equal(f.counters.poll_auto, 2);
  assert.equal(f.counters.deliver_ok, 3);
});

test('epoch is stable across increments', () => {
  const { home, store } = fresh();
  store.incr('poll_auto');
  const e1 = readFile(home).epoch;
  store.incr('poll_auto');
  const e2 = readFile(home).epoch;
  assert.equal(e1, e2);
  assert.ok(e1.length > 0);
});

test('incr by <= 0 is a no-op', () => {
  const { home, store } = fresh();
  store.incr('poll_auto'); // a real incr creates the file so the no-op is observable
  store.incr('x', 0);
  store.incr('x', -5);
  const f = readFile(home);
  assert.equal(f.counters.x ?? 0, 0);
  assert.equal(f.counters.poll_auto, 1); // real counter unaffected by the no-ops
});

test('corrupt file resets to fresh epoch without throwing', () => {
  const { home, store } = fresh();
  const dir = join(home, 'instances', 'agxp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'counters.json'), '{bad json');
  store.incr('poll_auto'); // must not throw
  const f = readFile(home);
  assert.equal(f.counters.poll_auto, 1);
  assert.ok(f.epoch.length > 0);
});

console.log(`\ncounter-store: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
