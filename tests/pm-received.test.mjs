#!/usr/bin/env node
/** M2: pm_received counts meta.message_count (0 when absent), not +1/event. */
import assert from 'node:assert/strict';

// Minimal mirror of channel.ts's counting rule, kept in lockstep with emit().
// If channel.ts changes the rule, update this expectation.
function pmDelta(eventType, meta) {
  if (eventType !== 'thread_update') return 0;
  return parseInt(meta.message_count ?? '', 10) || 0;
}

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } }

test('counts message_count for thread_update', () => assert.equal(pmDelta('thread_update', { message_count: '3' }), 3));
test('absent message_count → 0', () => assert.equal(pmDelta('thread_update', {}), 0));
test('non-thread_update → 0', () => assert.equal(pmDelta('timeline_update', { message_count: '5' }), 0));

console.log(`\npm-received: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
