#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventStreamClient } from '../src/event-stream.ts';

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nevent-stream forwarder tests\n');

// The EventStreamClient constructor does NOT spawn — only start() does — so we
// can build it with agxpBin: 'true' (a no-op binary) and drive the private
// handleLine directly. We never call start(), so no real child is spawned.
function makeClient({ onEvent } = {}) {
  return new EventStreamClient({
    serverName: 'test-server',
    agxpBin: 'true',
    onEvent: onEvent ?? (async () => {}),
    onAuthRequired: async () => {},
  });
}

await testAsync('handleLine forwards a rendered Block to onEvent', async () => {
  let received = null;
  const client = makeClient({ onEvent: async (block) => { received = block; } });
  try {
    client.handleLine(JSON.stringify({
      type: 'subscription_match',
      agent_block: 'card text',
      meta: { tier: 'high' },
      ack_token: 'tok',
    }));
    // handleLine fires onEvent asynchronously; give it a tick to resolve.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(received?.type, 'subscription_match');
    assert.equal(received?.agent_block, 'card text');
    assert.equal(received?.ack_token, 'tok');
  } finally {
    await client.stop();
  }
});

await testAsync('handleLine tolerates a Block without agent_block/meta/ack_token', async () => {
  let received = null;
  const client = makeClient({ onEvent: async (block) => { received = block; } });
  try {
    client.handleLine(JSON.stringify({ type: 'contact_event' }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(received?.type, 'contact_event');
    assert.equal(received?.agent_block, undefined);
  } finally {
    await client.stop();
  }
});

await testAsync('handleLine ignores blank lines', async () => {
  let count = 0;
  const client = makeClient({ onEvent: async () => { count++; } });
  try {
    client.handleLine('   ');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(count, 0);
  } finally {
    await client.stop();
  }
});

await testAsync('handleLine logs (not throws) on unparseable line', async () => {
  let count = 0;
  const client = makeClient({ onEvent: async () => { count++; } });
  try {
    client.handleLine('not-json');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(count, 0, 'a bad line must not reach onEvent');
  } finally {
    await client.stop();
  }
});

await testAsync('scheduleRestart fires onConnectionLost on give-up (20 failures)', async () => {
  let lost = false;
  const client = new EventStreamClient({
    serverName: 'test-server',
    agxpBin: 'true',
    onEvent: async () => {},
    onAuthRequired: async () => {},
    onConnectionLost: async () => { lost = true; },
  });
  try {
    client.running = true;
    client.consecutiveFailures = 19; // next scheduleRestart() -> 20 -> give up
    client.scheduleRestart();
    assert.equal(lost, true, 'onConnectionLost should fire when the breaker trips');
    assert.equal(client.isRunning(), false, 'stream should stop on give-up');
  } finally {
    await client.stop();
  }
});

await testAsync('scheduleRestart does NOT fire onConnectionLost below the threshold', async () => {
  let lost = false;
  const client = new EventStreamClient({
    serverName: 'test-server',
    agxpBin: 'true',
    onEvent: async () => {},
    onAuthRequired: async () => {},
    onConnectionLost: async () => { lost = true; },
  });
  try {
    client.running = true;
    client.consecutiveFailures = 5; // well below 20 -> reconnect, no give-up
    client.scheduleRestart();
    assert.equal(lost, false, 'onConnectionLost must not fire before 20 consecutive failures');
  } finally {
    await client.stop();
  }
});

// Structural: confirms the P1 spawn format swap (json → agent) and that the
// shell no longer extracts a checkpoint from each frame (the CLI owns both the
// reconnect loop and the checkpoint cursor now).
await testAsync('structural: event-stream.ts spawns with -o agent and no longer reads a per-line checkpoint', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'event-stream.ts'),
    'utf8',
  );
  assert.ok(src.includes("'-o', 'agent'"), "expected spawn args to include '-o', 'agent'");
  assert.ok(!src.includes("'-o', 'json'"), "old '-o json' spawn must be gone");
  assert.ok(!/lastCheckpoint/.test(src), 'per-line checkpoint tracking must be removed (CLI owns it now)');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
