#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createChannelNotify, parseThreadMessageCount } from '../src/channel.js';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

await testAsync('thread_update increments pm_received by message_count before delivery', async () => {
  const calls = [];
  const counters = {
    incr(name, by) {
      calls.push({ type: 'counter', name, by });
    },
  };
  const shellLog = {
    info(input) { calls.push({ type: 'log', level: 'info', event: input.event, attrs: input.attrs }); },
    warn(input) { calls.push({ type: 'log', level: 'warn', event: input.event, attrs: input.attrs }); },
    debug(input) { calls.push({ type: 'log', level: 'debug', event: input.event, attrs: input.attrs }); },
  };
  const notify = createChannelNotify({
    notify: async () => {
      calls.push({ type: 'notify' });
    },
    counters,
    shellLog,
    serverName: 'test',
  });

  await notify({
    method: 'notifications/claude/channel',
    params: {
      content: 'body',
      meta: { event_type: 'thread_update', message_count: '3' },
    },
  });

  const notifyIndex = calls.findIndex((call) => call.type === 'notify');
  const pmIndex = calls.findIndex((call) => call.type === 'counter' && call.name === 'pm_received');
  assert.ok(pmIndex >= 0, 'pm_received should be incremented');
  assert.ok(notifyIndex >= 0, 'notify should be called');
  assert.ok(pmIndex < notifyIndex, 'pm_received should happen before delivery');
  assert.deepEqual(calls[pmIndex], { type: 'counter', name: 'pm_received', by: 3 });
  assert.ok(calls.some((call) => call.type === 'log' && call.event === 'pm_received' && call.attrs.message_count === 3));
});

await testAsync('parseThreadMessageCount only accepts complete non-negative safe integer strings', async () => {
  const cases = [
    [undefined, 0],
    ['', 0],
    ['-1', 0],
    ['3.5', 0],
    ['3abc', 0],
    ['9007199254740992', 0],
    ['0', 0],
    ['3', 3],
  ];

  for (const [messageCount, expected] of cases) {
    assert.equal(parseThreadMessageCount(messageCount), expected, `message_count=${String(messageCount)}`);
  }
});

await testAsync('non-thread_update does not increment pm_received', async () => {
  const calls = [];
  const counters = {
    incr(name, by) {
      calls.push({ type: 'counter', name, by });
    },
  };
  const shellLog = {
    info(input) { calls.push({ type: 'log', level: 'info', event: input.event, attrs: input.attrs }); },
    warn(input) { calls.push({ type: 'log', level: 'warn', event: input.event, attrs: input.attrs }); },
    debug(input) { calls.push({ type: 'log', level: 'debug', event: input.event, attrs: input.attrs }); },
  };
  const notify = createChannelNotify({
    notify: async () => {
      calls.push({ type: 'notify' });
    },
    counters,
    shellLog,
    serverName: 'test',
  });

  await notify({
    method: 'notifications/claude/channel',
    params: {
      content: 'body',
      meta: { event_type: 'timeline_update', message_count: '5' },
    },
  });

  assert.equal(calls.some((call) => call.type === 'counter' && call.name === 'pm_received'), false);
});

console.log(`\npm-received: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
