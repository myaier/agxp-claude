#!/usr/bin/env node
/**
 * Tests for src/advisory-checker.ts — the periodic advisory poller that reads
 * <HomeDir>/advisory.json and emits a plugin_update_required /
 * plugin_update_available channel event when the `plugin` field CHANGES.
 *
 * Mirrors the emit.test.mjs capturing-fake pattern: we drive the checker's
 * `tick()` directly (no real timers) and assert on the captured notifications.
 * Dedupe is the core invariant: the same advisory value must NOT re-emit.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdvisoryChecker } from '../src/advisory-checker.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

function makeChecker() {
  const sent = [];
  const checker = new AdvisoryChecker({
    serverName: 'test-server',
    async emit(eventType, meta, content) {
      sent.push({ eventType, meta, content });
    },
  });
  return { checker, sent };
}

// Like makeChecker, but injects a runSkillsSync spy so we can assert that the
// skills advisory branch fires it exactly once per CHANGE.
function makeCheckerWithSkillsSpy(spy) {
  const sent = [];
  const calls = spy.calls ?? (spy.calls = []);
  const checker = new AdvisoryChecker({
    serverName: 'test-server',
    async emit(eventType, meta, content) {
      sent.push({ eventType, meta, content });
    },
    async runSkillsSync() {
      calls.push('sync');
      if (spy.reject) throw new Error('sync failed (fake)');
    },
  });
  return { checker, calls, sent };
}

// Variant that returns a manually-controlled pending promise per call, so a
// test can hold a sync in-flight across ticks and assert in-flight dedupe.
// `controls` accumulates {resolve, reject} for each invocation; resolve()
// completes the corresponding pending sync. `waitForCalls(n)` returns a
// promise that resolves once the spy has been entered at least n times —
// needed because tick() does a real async fs read before reaching
// runSkillsSync, so the test can't just `await Promise.resolve()`.
function makeCheckerWithDeferredSkillsSync(controls) {
  const sent = [];
  const calls = [];
  const waiters = []; // queued {n, resolve}
  function notify() {
    while (waiters.length && waiters[0].n <= calls.length) {
      waiters.shift().resolve();
    }
  }
  function waitForCalls(n) {
    if (calls.length >= n) return Promise.resolve();
    return new Promise((resolve) => { waiters.push({ n, resolve }); });
  }
  const checker = new AdvisoryChecker({
    serverName: 'test-server',
    async emit(eventType, meta, content) {
      sent.push({ eventType, meta, content });
    },
    async runSkillsSync() {
      calls.push('sync');
      notify();
      return new Promise((resolve, reject) => {
        controls.push({ resolve, reject });
      });
    },
  });
  return { checker, calls, sent, waitForCalls };
}

function withHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agxp-advchk-'));
    const prev = process.env.AGXP_HOME;
    process.env.AGXP_HOME = dir;
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.AGXP_HOME; else process.env.AGXP_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function writeAdv(home, rec) {
  writeFileSync(join(home, 'advisory.json'), JSON.stringify(rec));
}

console.log('\nadvisory-checker (periodic advisory poll + dedupe) tests\n');

await testAsync('tick emits plugin_update_required when plugin==="required"', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventType, 'plugin_update_required');
  assert.equal(sent[0].meta.server, 'test-server');
  assert.match(sent[0].content, /AGXP_PLUGIN_UPDATE_REQUIRED/);
}));

await testAsync('tick emits plugin_update_available when plugin==="available"', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'available' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventType, 'plugin_update_available');
  assert.match(sent[0].content, /AGXP_PLUGIN_UPDATE_AVAILABLE/);
}));

// User-language rule coverage (review-r1): the plugin-update prompts are
// user-visible AGXP notifications, so they must carry USER_LANGUAGE_RULE so
// the agent replies in the user's language regardless of the payload language.
await testAsync('plugin_update_required prompt carries the user-language rule', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.match(sent[0].content, /User-facing reply language:/);
  assert.match(sent[0].content, /same language as the user's current conversation/);
  assert.match(sent[0].content, /untrusted AGXP network payloads/);
  assert.match(sent[0].content, /default to English/);
}));

await testAsync('plugin_update_available prompt carries the user-language rule', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'available' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.match(sent[0].content, /User-facing reply language:/);
  assert.match(sent[0].content, /same language as the user's current conversation/);
  assert.match(sent[0].content, /untrusted AGXP network payloads/);
  assert.match(sent[0].content, /default to English/);
}));

await testAsync('tick does NOT emit when plugin==="" (no nudge)', withHome(async () => {
  const { checker, sent } = makeChecker();
  await checker.tick(); // no file at all
  assert.equal(sent.length, 0);
}));

await testAsync('dedupe: same advisory value on consecutive ticks emits only once', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  await checker.tick();
  await checker.tick();
  assert.equal(sent.length, 1);
}));

await testAsync('transition required→available re-emits with the new type', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  writeAdv(home, { plugin: 'available' });
  await checker.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].eventType, 'plugin_update_required');
  assert.equal(sent[1].eventType, 'plugin_update_available');
}));

await testAsync('transition required→"" clears the nudge (no re-emit, but later required re-emits)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  unlinkSync(join(home, 'advisory.json')); // now absent → plugin ""
  await checker.tick();
  assert.equal(sent.length, 1); // no second emit
  writeAdv(home, { plugin: 'required' });
  await checker.tick();
  assert.equal(sent.length, 2); // re-emits because it transitioned away & back
}));

await testAsync('transition available→required re-emits with the new type (symmetric)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'available' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventType, 'plugin_update_available');
  writeAdv(home, { plugin: 'required' });
  await checker.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].eventType, 'plugin_update_required');
  // Repeating the same state must NOT re-emit.
  await checker.tick();
  assert.equal(sent.length, 2);
}));

await testAsync('prompt content includes the manual update command', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required' });
  const { checker, sent } = makeChecker();
  await checker.tick();
  assert.match(sent[0].content, /claude plugin marketplace update agxp-marketplace/);
  assert.match(sent[0].content, /\/plugin install agxp@agxp-marketplace/);
}));

await testAsync('start/stop manages the interval and stop-before-start is safe', withHome(async () => {
  const { checker } = makeChecker();
  checker.stop(); // must not throw
  checker.start(60);
  checker.start(60); // double-start safe (no duplicate interval)
  checker.stop();
  assert.ok(true);
}));

// ── skills advisory branch (P2: auto-run `agxp skills sync`) ──────────────
//
// The `skills` field uses the same CHANGE-dedupe model as `plugin`, but
// instead of emitting a channel event it runs config.runSkillsSync(). The
// sync must dedupe ONLY after success: a rejecting sync retries on the next
// tick without being marked done. `available` also fires (skills hot-reload
// is safe, unlike a shell upgrade).

await testAsync('skills==="required" CHANGE fires runSkillsSync once; same value second tick dedupes', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const spy = { calls: [] };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  assert.equal(calls.length, 1, 'sync fired on first tick');
  await checker.tick();
  await checker.tick();
  assert.equal(calls.length, 1, 'deduped on subsequent ticks');
}));

await testAsync('skills==="available" also fires runSkillsSync (hot-reload safe)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'available' });
  const spy = { calls: [] };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  assert.equal(calls.length, 1, 'available fires sync too');
}));

await testAsync('skills==="required" with rejecting runSkillsSync retries on next tick (no dedupe-on-failure)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const spy = { calls: [], reject: true };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  await checker.tick();
  await checker.tick();
  assert.equal(calls.length, 3, 'each tick retries because success never recorded');
}));

await testAsync('skills required→""→required re-fires (transition away resets dedupe)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const spy = { calls: [] };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  assert.equal(calls.length, 1);
  unlinkSync(join(home, 'advisory.json')); // skills → ""
  await checker.tick();
  assert.equal(calls.length, 1, 'no sync when clearing');
  writeAdv(home, { skills: 'required' });
  await checker.tick();
  assert.equal(calls.length, 2, 're-fires after transition away & back');
}));

await testAsync('skills branch does not disturb plugin branch (plugin_update_required still emits)', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { plugin: 'required', skills: 'required' });
  const spy = { calls: [] };
  const { checker, calls, sent } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  assert.equal(calls.length, 1, 'skills sync ran');
  assert.equal(sent.length, 1, 'plugin event emitted too');
  assert.equal(sent[0].eventType, 'plugin_update_required');
}));

await testAsync('skills==="" never fires runSkillsSync', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: '' });
  const spy = { calls: [] };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  await checker.tick();
  assert.equal(calls.length, 0);
}));

await testAsync('transition required→available re-fires sync with the new value', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const spy = { calls: [] };
  const { checker, calls } = makeCheckerWithSkillsSpy(spy);
  await checker.tick();
  writeAdv(home, { skills: 'available' });
  await checker.tick();
  assert.equal(calls.length, 2, 'value CHANGE re-fires even though both are sync-worthy');
  await checker.tick();
  assert.equal(calls.length, 2, 'same value dedupes');
}));

// ── in-flight dedupe (P2 codex-r1) ──────────────────────────────────────────
//
// A tick that is mid-`runSkillsSync()` (sync can take up to 60s) must NOT let
// a concurrently-fired tick spawn a SECOND `agxp skills sync` — two processes
// rm/cp'ing the same ~/.claude/skills dir race and corrupt the install. The
// in-flight flag mirrors Hermes' `_skills_sync_task.done()` guard. While a sync
// is pending, a second tick must skip entirely (no second spawn, no dedupe
// write); once the pending sync resolves successfully, a third tick dedupes.

await testAsync('in-flight sync is not re-spawned by a concurrent tick; dedupes after success', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const controls = [];
  const { checker, calls, waitForCalls } = makeCheckerWithDeferredSkillsSync(controls);

  // Tick #1 starts the sync but it stays pending (we hold the resolve).
  const tick1 = checker.tick();
  // Wait until runSkillsSync has actually been entered — the fs read inside
  // tick() is real async IO, so a couple of microtask yields isn't enough.
  await waitForCalls(1);
  assert.equal(calls.length, 1, 'first tick spawned sync');
  assert.equal(controls.length, 1, 'one pending sync control');
  assert.ok(checker.skillsSyncInFlight === true, 'in-flight flag set while sync pending');

  // Tick #2 fires WHILE sync #1 is still pending. Must be skipped — no second
  // spawn, no dedupe write (the pending one owns this advisory value).
  await checker.tick();
  assert.equal(calls.length, 1, 'second tick did NOT spawn a concurrent sync');
  assert.ok(checker.skillsSyncInFlight === true, 'in-flight flag still set');

  // Complete the pending sync successfully.
  controls[0].resolve();
  await tick1;
  assert.ok(checker.skillsSyncInFlight === false, 'in-flight flag cleared after success');

  // Tick #3: same advisory value → dedupes (success was recorded by tick #1).
  await checker.tick();
  assert.equal(calls.length, 1, 'third tick deduped after successful sync');
}));

await testAsync('in-flight sync failure clears the flag so the next tick retries', withHome(async (dir) => {
  const home = join(dir, '.agxp');
  mkdirSync(home);
  writeAdv(home, { skills: 'required' });
  const controls = [];
  const { checker, calls, waitForCalls } = makeCheckerWithDeferredSkillsSync(controls);

  // Tick #1 spawns sync; held pending.
  const tick1 = checker.tick();
  await waitForCalls(1);
  assert.equal(calls.length, 1);

  // Tick #2 while in-flight: skipped.
  await checker.tick();
  assert.equal(calls.length, 1, 'concurrent tick skipped');

  // Fail the pending sync.
  controls[0].reject(new Error('sync failed (fake)'));
  await tick1;
  assert.ok(checker.skillsSyncInFlight === false, 'flag cleared after failure');
  // Dedupe NOT recorded on failure → next tick will retry.
  assert.ok(checker.lastSkillsAdvisory === '', 'dedupe not recorded on failure');

  // Tick #3: retries because the failed sync left dedupe unset.
  const tick3 = checker.tick();
  await waitForCalls(2); // wait for the retry spawn to actually run
  assert.equal(calls.length, 2, 'third tick retried after failure');
  controls[1].resolve();
  await tick3;
}));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
