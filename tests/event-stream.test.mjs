#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventStreamClient } from '../src/event-stream.ts';

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nevent-stream checkpoint tests\n');

// The EventStreamClient constructor does NOT spawn — only start() does — so we
// can build it with agxpBin: 'true' (a no-op binary) and drive the private
// handleLine directly. We never call start(), so no real child is spawned.
function makeClient() {
  return new EventStreamClient({
    serverName: 'test-server',
    agxpBin: 'true',
    onEvent: async () => {},
    onAuthRequired: async () => {},
  });
}

await testAsync('handleLine reads data.next_checkpoint into lastCheckpoint', async () => {
  const client = makeClient();
  try {
    assert.equal(client.getLastCheckpoint(), null);
    client.handleLine(JSON.stringify({ type: 'thread_update', data: { next_checkpoint: '999' } }));
    assert.equal(client.getLastCheckpoint(), '999');
  } finally {
    await client.stop();
  }
});

await testAsync('handleLine does NOT read the stale data.next field', async () => {
  const client = makeClient();
  try {
    // seed a known checkpoint
    client.handleLine(JSON.stringify({ type: 'thread_update', data: { next_checkpoint: '999' } }));
    assert.equal(client.getLastCheckpoint(), '999');
    // a frame carrying the OLD field name must not overwrite it
    client.handleLine(JSON.stringify({ type: 'thread_update', data: { next: '888' } }));
    assert.equal(client.getLastCheckpoint(), '999');
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

await testAsync('structural: src/event-stream.ts uses next_checkpoint, not data.next', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'event-stream.ts'),
    'utf8',
  );
  assert.ok(src.includes('next_checkpoint'), 'expected next_checkpoint in source');
  // The old buggy property access must be gone.
  assert.ok(!/event\.data\?\.next\b/.test(src), 'stale event.data?.next access still present');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
