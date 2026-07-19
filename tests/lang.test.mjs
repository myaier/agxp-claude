#!/usr/bin/env node
/**
 * Tests for src/lang.ts — the AGXP_ONBOARDING_LANG-aware language fallback.
 * Mirrors plugins/codex/src/lang.test.ts.
 *
 * Run: bun tests/lang.test.mjs
 */
import assert from 'node:assert/strict';

import { buildUserLanguageRule, languageFallback, USER_LANGUAGE_RULE } from '../src/lang.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nlang.ts (AGXP_ONBOARDING_LANG fallback) tests\n');

test('unset env falls back to English', () => {
  assert.equal(languageFallback({}), 'English');
  assert.match(buildUserLanguageRule({}), /default to English\./);
});

test('zh seed falls back to 简体中文', () => {
  assert.equal(languageFallback({ AGXP_ONBOARDING_LANG: 'zh' }), '简体中文');
  assert.match(buildUserLanguageRule({ AGXP_ONBOARDING_LANG: 'zh' }), /default to 简体中文\./);
});

test('junk / padded seeds normalize or fall back', () => {
  assert.equal(languageFallback({ AGXP_ONBOARDING_LANG: 'fr' }), 'English');
  assert.equal(languageFallback({ AGXP_ONBOARDING_LANG: ' ZH ' }), '简体中文');
});

test('module constant equals builder for current process env', () => {
  assert.equal(USER_LANGUAGE_RULE, buildUserLanguageRule(process.env));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
