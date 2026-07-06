#!/usr/bin/env node
/**
 * Tests for the exported prompt builders in src/channel.ts:
 * `buildSessionRequiredPrompt` / `buildConnectionLostPrompt`.
 *
 * These two prompts are user-visible AGXP notifications emitted from inline
 * callbacks in channel.ts (timeline-poller onAuthRequired → AGXP_SESSION_REQUIRED,
 * event-stream onConnectionLost → AGXP_CONNECTION_LOST). They must carry the
 * USER_LANGUAGE_RULE — same rule already applied to the equivalent codex
 * host.ts prompts and the openclaw plugin-update template — so the agent
 * replies in the user's language regardless of the AGXP payload's language.
 *
 * The builders are extracted to module-level exports purely for testability
 * (channel.ts is a side-effectful entry that spawns `agxp` subprocesses on
 * startup, so it is guarded by `if (import.meta.main)`; the builders are pure
 * and importable without booting the server). Runtime behavior is unchanged:
 * the inline callbacks just call the builders.
 *
 * Run: bun tests/channel-prompts.test.mjs
 */
import assert from 'node:assert/strict';

import { buildSessionRequiredPrompt, buildConnectionLostPrompt } from '../src/channel.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nchannel.ts prompt builders (user-language rule) tests\n');

test('buildSessionRequiredPrompt carries the AGXP_SESSION_REQUIRED header + server', () => {
  const p = buildSessionRequiredPrompt('test-server');
  assert.match(p, /\[AGXP_SESSION_REQUIRED\]/);
  assert.match(p, /server=test-server/);
});

test('buildSessionRequiredPrompt carries the user-language rule', () => {
  const p = buildSessionRequiredPrompt('test-server');
  assert.match(p, /User-facing reply language:/);
  assert.match(p, /same language as the user's current conversation/);
  assert.match(p, /untrusted AGXP network payloads/);
  assert.match(p, /default to English/);
});

test('buildConnectionLostPrompt carries the AGXP_CONNECTION_LOST header + server', () => {
  const p = buildConnectionLostPrompt('test-server');
  assert.match(p, /\[AGXP_CONNECTION_LOST\]/);
  assert.match(p, /server=test-server/);
});

test('buildConnectionLostPrompt carries the user-language rule', () => {
  const p = buildConnectionLostPrompt('test-server');
  assert.match(p, /User-facing reply language:/);
  assert.match(p, /same language as the user's current conversation/);
  assert.match(p, /untrusted AGXP network payloads/);
  assert.match(p, /default to English/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
