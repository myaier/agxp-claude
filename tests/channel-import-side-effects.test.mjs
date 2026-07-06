#!/usr/bin/env node
/**
 * Regression guard: importing channel.ts for its pure prompt builders must NOT
 * install process-level handlers (those belong to the entry-point main path).
 *
 * Round 1 of codex-review-loop guarded the MCP connect + producer .start()
 * calls behind `if (import.meta.main)`, but round 2 found that five
 * process-level handler REGISTRATIONS still ran at module top level on import:
 *   - process.stderr.on('error', ...)         (EPIPE exit guard)
 *   - process.on('SIGTERM'/'SIGINT', ...)      (shutdown)
 *   - process.on('unhandledRejection', ...)
 *   - process.on('uncaughtException', ...)
 *
 * That mutates the importer/test process's signal + rejection behavior. This
 * test uses dynamic import + baseline comparison (channel-prompts.test.mjs
 * already statically imports channel.js, so its baseline is already polluted
 * and can't observe the delta). The pure functions `shutdown` /
 * `isPipeBreakError` are definitions only and don't run on import — only the
 * `process.on(...)` / `process.stderr.on(...)` registration calls do.
 *
 * Run: bun tests/channel-import-side-effects.test.mjs
 */
import assert from 'node:assert/strict';

const events = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
const before = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
const stderrBefore = process.stderr.listenerCount('error');

await import('../src/channel.js');

let passed = 0, failed = 0;
for (const e of events) {
  const want = before[e];
  const got = process.listenerCount(e);
  if (got === want) {
    passed++;
    console.log(`  ✓ import does not register ${e} (before=${want} after=${got})`);
  } else {
    failed++;
    console.log(`  ✗ import registered ${e}: before=${want} after=${got}`);
  }
}

if (process.stderr.listenerCount('error') === stderrBefore) {
  passed++;
  console.log(`  ✓ import does not register stderr error handler (before=${stderrBefore} after=${process.stderr.listenerCount('error')})`);
} else {
  failed++;
  console.log(`  ✗ import registered stderr error handler: before=${stderrBefore} after=${process.stderr.listenerCount('error')}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
