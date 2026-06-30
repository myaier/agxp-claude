#!/usr/bin/env node
/**
 * skills env pin tests (codex-r3, mirrors hermes r2).
 *
 * runSkillsSync() writes ~/.claude/skills (hardcoded). But the other `agxp`
 * child calls (timeline pull, identity, event watch, event ack) inherit
 * process.env — if a stray AGXP_SKILLS_DIR is set, those calls read skills
 * from the override dir, report X-Skills-Ver from it, and the server keeps
 * advising while same-value dedupe suppresses re-sync → silent staleness.
 *
 * agxpChildEnv() pins AGXP_SKILLS_DIR to claudeSkillsDir() so the reported
 * version always comes from the dir auto-sync actually writes.
 */
import assert from 'node:assert/strict';
import { claudeSkillsDir, agxpChildEnv } from '../src/config.ts';

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nskills env pin (codex-r3) tests\n');

await testAsync('claudeSkillsDir() returns ${HOME}/.claude/skills', () => {
  const expected = `${process.env.HOME ?? ''}/.claude/skills`;
  assert.equal(claudeSkillsDir(), expected);
});

await testAsync('agxpChildEnv() pins AGXP_SKILLS_DIR to claudeSkillsDir() even when process.env has a stray override', () => {
  const bogus = '/tmp/bogus-claude-skills-env-test';
  const saved = process.env.AGXP_SKILLS_DIR;
  process.env.AGXP_SKILLS_DIR = bogus;
  try {
    const env = agxpChildEnv();
    assert.equal(env.AGXP_SKILLS_DIR, claudeSkillsDir(),
      `expected pin to ${claudeSkillsDir()}, got ${env.AGXP_SKILLS_DIR}`);
    assert.notEqual(env.AGXP_SKILLS_DIR, bogus,
      'stray AGXP_SKILLS_DIR leaked through — pin did not override');
  } finally {
    if (saved === undefined) delete process.env.AGXP_SKILLS_DIR;
    else process.env.AGXP_SKILLS_DIR = saved;
  }
});

await testAsync('agxpChildEnv() still inherits the rest of process.env', () => {
  process.env.AGXP_CHILD_ENV_TEST_MARKER = 'present';
  try {
    const env = agxpChildEnv();
    assert.equal(env.AGXP_CHILD_ENV_TEST_MARKER, 'present',
      'agxpChildEnv should spread process.env');
    assert.equal(env.AGXP_SKILLS_DIR, claudeSkillsDir());
  } finally {
    delete process.env.AGXP_CHILD_ENV_TEST_MARKER;
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
