#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveStartupDelayMs, DEFAULT_STARTUP_DELAY_MS } from '../src/startup-delay.ts';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nstartup-delay tests\n');

test('default delay is 3000ms', () => {
  assert.equal(DEFAULT_STARTUP_DELAY_MS, 3000);
});

test('empty env falls back to default', () => {
  assert.equal(resolveStartupDelayMs({}), 3000);
});

test('unset AGXP_STARTUP_DELAY_MS falls back to default', () => {
  assert.equal(resolveStartupDelayMs({ OTHER_VAR: 'x' }), 3000);
});

test('numeric string is parsed', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '1000' }), 1000);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '0' }), 0);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '5000' }), 5000);
});

test('zero is allowed (fastest handshake)', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '0' }), 0);
});

test('garbage value falls back to default', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: 'not-a-number' }), 3000);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '' }), 3000);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: 'abc123' }), 3000);
});

test('negative value falls back to default', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '-1' }), 3000);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '-500' }), 3000);
});

test('non-finite values (NaN/Infinity) fall back to default', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: 'NaN' }), 3000);
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: 'Infinity' }), 3000);
});

test('floats are accepted', () => {
  assert.equal(resolveStartupDelayMs({ AGXP_STARTUP_DELAY_MS: '1500.5' }), 1500.5);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
