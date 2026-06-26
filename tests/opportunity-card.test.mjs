#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderOpportunityCard } from '../src/opportunity-card.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'contracts/radar/opportunity-card-fixture.json'), 'utf8'));
const expected = readFileSync(join(root, 'contracts/radar/opportunity-card-expected.txt'), 'utf8').replace(/\r?\n$/, '');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nopportunity-card renderer tests\n');
test('matches the shared fixture byte-for-byte', () => {
  assert.equal(renderOpportunityCard(fixture.data), expected);
});
test('omits author line when author absent', () => {
  const out = renderOpportunityCard({ tier: 'low', title: 'x', post_id: '1' });
  assert.ok(!out.includes('from:'));
  assert.ok(out.includes('[low]'));
});
test('headcount 0 falls through to capacity (falsy semantics)', () => {
  const out = renderOpportunityCard({ tier: 'high', title: 'x', payload: { headcount: 0, capacity: 5 } });
  assert.ok(out.includes('名额: 5（剩余见 /derive）'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
