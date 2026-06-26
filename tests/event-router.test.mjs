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

// ---- Plan 2 T6: contact + backfill branches ----

function fakeDeps() {
  const calls = { emits: [], messagesRead: [], matchesRead: [], contactRead: [], commitmentsRead: [] };
  return {
    calls,
    emit: async (eventType, meta, content) => { calls.emits.push({ eventType, meta, content }); },
    markMessagesRead: async (ids) => { calls.messagesRead.push(ids); return true; },
    markMatchesRead: async (subId, ids) => { calls.matchesRead.push({ subId, ids }); return true; },
    markContactEventsRead: async (ids) => { calls.contactRead.push(ids); return true; },
    markCommitmentsRead: async (ids) => { calls.commitmentsRead.push(ids); return true; },
  };
}

await testAsync('contact_accepted emits contact_event /accepted/ and does NOT ack', async () => {
  const deps = fakeDeps();
  await routeEvent({ type: 'contact_accepted', data: { contact_id: 42 } }, deps);
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.emits[0].eventType, 'contact_event');
  assert.match(deps.calls.emits[0].content, /accepted/);
  assert.equal(deps.calls.contactRead.length, 0);
  assert.equal(deps.calls.commitmentsRead.length, 0);
  assert.equal(deps.calls.matchesRead.length, 0);
  assert.equal(deps.calls.messagesRead.length, 0);
});

await testAsync('contact_cancelled emits contact_event /cancelled/ and does NOT ack', async () => {
  const deps = fakeDeps();
  await routeEvent({ type: 'contact_cancelled', data: { contact_id: 7 } }, deps);
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.emits[0].eventType, 'contact_event');
  assert.match(deps.calls.emits[0].content, /cancelled/);
  assert.equal(deps.calls.contactRead.length, 0);
});

await testAsync('thread_update with contact_requests and NO messages emits contact_request only (no empty thread_update)', async () => {
  const deps = fakeDeps();
  const event = {
    type: 'thread_update',
    data: {
      contact_requests: [
        { from_name: 'alice', request_id: 'r1' },
        { from_name: 'bob', request_id: 'r2' },
      ],
    },
  };
  await routeEvent(event, deps);
  const types = deps.calls.emits.map((e) => e.eventType);
  assert.ok(types.includes('contact_request'), `expected contact_request in ${JSON.stringify(types)}`);
  assert.ok(!types.includes('thread_update'), `must NOT emit empty thread_update, got ${JSON.stringify(types)}`);
  assert.equal(deps.calls.contactRead.length, 0, 'pending contact_request must NOT be acked');
  // meta.count is a string of the count
  const cr = deps.calls.emits.find((e) => e.eventType === 'contact_request');
  assert.equal(cr.meta.count, '2');
});

await testAsync('subscription_matches_backfill groups matches by sub_id and acks each group via markMatchesRead', async () => {
  const deps = fakeDeps();
  await routeEvent({
    type: 'subscription_matches_backfill',
    data: {
      matches: [
        { sub_id: '7', match_id: '1', post_id: '42' },
        { sub_id: '7', match_id: '2', post_id: '43' },
        { sub_id: '9', match_id: '3', post_id: '44' },
      ],
      total_unviewed: 3,
      has_more: false,
    },
  }, deps);
  // emits one backfill_summary
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.emits[0].eventType, 'backfill_summary');
  // F2: first-page rows render in content (not just the count)
  const matchContent = deps.calls.emits[0].content;
  assert.ok(matchContent.includes('[match 1]'), `match row 1 must render, got: ${matchContent}`);
  assert.ok(matchContent.includes('sub=7'), `sub_id must render, got: ${matchContent}`);
  assert.ok(matchContent.includes('post='), `post label must render, got: ${matchContent}`);
  // acked twice, grouped by sub
  assert.equal(deps.calls.matchesRead.length, 2);
  const bySub = {};
  for (const { subId, ids } of deps.calls.matchesRead) bySub[subId] = ids;
  assert.deepEqual(bySub, { '7': ['1', '2'], '9': ['3'] });
  // no other acks
  assert.equal(deps.calls.contactRead.length, 0);
  assert.equal(deps.calls.commitmentsRead.length, 0);
});

await testAsync('commitments_backfill acks via markCommitmentsRead with pact_ids', async () => {
  const deps = fakeDeps();
  await routeEvent({
    type: 'commitments_backfill',
    data: {
      commitments: [
        { pact_id: 'p1', template_type: 'mutual_commitment', status: 'pending' },
        { pact_id: 'p2', template_type: 'mutual_commitment', status: 'accepted' },
      ],
      total_unviewed: 2,
      has_more: true,
      next: 'cursor-xyz',
    },
  }, deps);
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.emits[0].eventType, 'backfill_summary');
  // F2: first-page commitment rows render in content
  const commitContent = deps.calls.emits[0].content;
  assert.ok(commitContent.includes('[pact p1]'), `pact row p1 must render, got: ${commitContent}`);
  assert.ok(commitContent.includes('mutual_commitment'), `template_type must render, got: ${commitContent}`);
  assert.ok(commitContent.includes('pending'), `status must render, got: ${commitContent}`);
  assert.equal(deps.calls.commitmentsRead.length, 1);
  assert.deepEqual(deps.calls.commitmentsRead[0], ['p1', 'p2']);
  assert.equal(deps.calls.contactRead.length, 0);
  assert.equal(deps.calls.matchesRead.length, 0);
});

await testAsync('contact_events_backfill acks via markContactEventsRead with request_ids', async () => {
  const deps = fakeDeps();
  await routeEvent({
    type: 'contact_events_backfill',
    data: {
      events: [
        { request_id: 'req1', from_name: 'Bob', status: 'accepted', greeting: 'hi' },
        { request_id: 'req2', from_name: 'Ada', status: 'cancelled', greeting: '' },
      ],
      total_unviewed: 2,
      has_more: false,
    },
  }, deps);
  assert.equal(deps.calls.emits.length, 1);
  assert.equal(deps.calls.emits[0].eventType, 'backfill_summary');
  // F2: first-page contact-event rows render in content
  const evContent = deps.calls.emits[0].content;
  assert.ok(evContent.includes('[req req1]'), `request row req1 must render, got: ${evContent}`);
  assert.ok(evContent.includes('Bob'), `from_name must render, got: ${evContent}`);
  assert.ok(evContent.includes('accepted'), `status must render, got: ${evContent}`);
  assert.ok(evContent.includes('"hi"'), `greeting must render, got: ${evContent}`);
  assert.equal(deps.calls.contactRead.length, 1);
  assert.deepEqual(deps.calls.contactRead[0], ['req1', 'req2']);
  assert.equal(deps.calls.commitmentsRead.length, 0);
  assert.equal(deps.calls.matchesRead.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
