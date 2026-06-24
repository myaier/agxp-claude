#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createEmitter } from '../src/emit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');
const expectedCard = readFileSync(join(root, 'contracts/radar/opportunity-card-expected.txt'), 'utf8').replace(/\r?\n$/, '');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nemit (MCP notification) tests\n');

await testAsync('emit sends notifications/claude/channel with event_type in meta + card as content', async () => {
  let captured = null;
  const emit = createEmitter({ notify: async (params) => { captured = params; } });
  await emit('subscription_match', { tier: 'high' }, expectedCard);
  assert.equal(captured.method, 'notifications/claude/channel');
  assert.equal(captured.params.content, expectedCard);
  assert.equal(captured.params.meta.event_type, 'subscription_match');
  assert.equal(captured.params.meta.tier, 'high');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
