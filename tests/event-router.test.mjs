#!/usr/bin/env node
/**
 * routeEvent forwarder tests (P1-C1).
 *
 * After P1 the CLI owns event rendering: `agxp event watch -o agent` emits ONE
 * NDJSON line per rendered frame — `{type, agent_block, meta?, ack_token?}` —
 * and routeEvent is now a thin forwarder:
 *
 *   1. await deps.emit(block.type, block.meta ?? {}, block.agent_block)
 *   2. ONLY if (1) resolves AND block.ack_token is non-empty:
 *      await deps.ackToken(block.ack_token)
 *
 * This file locks the NO-LOSS boundary: never ack a block the agent never saw.
 */
import assert from 'node:assert/strict';
import { routeEvent } from '../src/event-router.ts';

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/**
 * Recording fake. `emitMode` controls whether emit resolves or rejects so we
 * can assert the no-loss branch (reject => ackToken NOT called).
 */
function fakeDeps({ emitRejects = false } = {}) {
  const calls = { emits: [], ackTokens: [] };
  return {
    calls,
    emit: async (eventType, meta, content) => {
      calls.emits.push({ eventType, meta, content });
      if (emitRejects) throw new Error('emit failed (test-injected)');
    },
    ackToken: async (token) => { calls.ackTokens.push(token); return true; },
  };
}

console.log('\nrouteEvent forwarder (P1-C1) tests\n');

// ---- emit path: agent_block is forwarded verbatim to deps.emit ----

await testAsync('emits (type, meta, agent_block) via deps.emit', async () => {
  const deps = fakeDeps();
  await routeEvent(
    { type: 'subscription_match', agent_block: 'card text', meta: { tier: 'high' }, ack_token: 'tok-1' },
    deps,
  );
  assert.equal(deps.calls.emits.length, 1);
  assert.deepEqual(deps.calls.emits[0], {
    eventType: 'subscription_match',
    meta: { tier: 'high' },
    content: 'card text',
  });
});

await testAsync('defaults meta to {} when block omits it', async () => {
  const deps = fakeDeps();
  await routeEvent(
    { type: 'thread_update', agent_block: 'msg text', ack_token: 'tok-2' },
    deps,
  );
  assert.deepEqual(deps.calls.emits[0].meta, {});
});

// ---- NO-LOSS boundary: emit resolve + ack_token present => ackToken called once ----

await testAsync('on emit RESOLVE with ack_token: calls ackToken exactly once', async () => {
  const deps = fakeDeps();
  await routeEvent(
    { type: 'subscription_match', agent_block: 'x', ack_token: 'tok-3' },
    deps,
  );
  assert.equal(deps.calls.ackTokens.length, 1, 'ackToken must be called once after a successful emit');
  assert.equal(deps.calls.ackTokens[0], 'tok-3');
});

// ---- NO-LOSS boundary: emit REJECT => ackToken NOT called ----

await testAsync('on emit REJECT: does NOT call ackToken (no-loss)', async () => {
  const deps = fakeDeps({ emitRejects: true });
  // routeEvent must swallow the emit rejection inside the no-loss branch (it
  // logs + skips ack); if it re-throws, the await here propagates and the
  // assert below never runs — the test would error rather than fail. Either
  // failure mode is acceptable; the strong assertion is the ackToken count.
  await routeEvent(
    { type: 'subscription_match', agent_block: 'x', ack_token: 'tok-4' },
    deps,
  );
  assert.equal(deps.calls.emits.length, 1, 'emit must still be attempted once');
  assert.equal(deps.calls.ackTokens.length, 0, 'ackToken must NOT be called when emit failed');
});

// ---- ack_token absent => never ack ----

await testAsync('ack_token absent: emits but never calls ackToken', async () => {
  const deps = fakeDeps();
  await routeEvent(
    { type: 'contact_event', agent_block: 'accepted' },
    deps,
  );
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.ackTokens.length, 0);
});

await testAsync('empty-string ack_token is treated as absent (never acks)', async () => {
  const deps = fakeDeps();
  await routeEvent(
    { type: 'contact_event', agent_block: 'accepted', ack_token: '' },
    deps,
  );
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.ackTokens.length, 0, 'empty ack_token must not trigger an ack');
});

// ---- ordering: emit happens BEFORE ackToken (so a throwing ack can't lose the block) ----

await testAsync('emit is awaited before ackToken (order matters for no-loss)', async () => {
  const order = [];
  const deps = {
    emit: async (eventType, meta, content) => { order.push('emit'); },
    ackToken: async (token) => { order.push('ack'); return true; },
  };
  await routeEvent(
    { type: 'subscription_match', agent_block: 'x', ack_token: 'tok-order' },
    deps,
  );
  assert.deepEqual(order, ['emit', 'ack']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
