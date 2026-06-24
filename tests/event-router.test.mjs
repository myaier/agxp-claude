#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeEvent } from '../src/event-router.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'contracts/radar/opportunity-card-fixture.json'), 'utf8'));
const expectedCard = readFileSync(join(root, 'contracts/radar/opportunity-card-expected.txt'), 'utf8').replace(/\r?\n$/, '');

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nevent-router dispatch tests\n');

await testAsync('subscription_match emits the card via channel + marks read', async () => {
  let emitted = null, marked = null;
  await routeEvent(fixture, {
    emit: async (eventType, meta, content) => { emitted = { eventType, meta, content }; },
    markMessagesRead: async () => true,
    markMatchesRead: async (subId, ids) => { marked = { subId, ids }; return true; },
  });
  assert.equal(emitted.eventType, 'subscription_match');
  assert.equal(emitted.meta.tier, 'high');
  assert.equal(emitted.content, expectedCard);
  assert.deepEqual(marked, { subId: '7', ids: ['99'] });
});

await testAsync('thread_update still emits + marks messages (regression)', async () => {
  let emitted = null, marked = null;
  const threadEvent = { type: 'thread_update', data: { messages: [{ message_id: 'm1', thread_id: 't1', content: 'hi', created_at: 1 }] } };
  await routeEvent(threadEvent, {
    emit: async (eventType, meta, content) => { emitted = { eventType, meta, content }; },
    markMessagesRead: async (ids) => { marked = ids; return true; },
    markMatchesRead: async () => true,
  });
  assert.equal(emitted.eventType, 'thread_update');
  assert.deepEqual(marked, ['m1']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
