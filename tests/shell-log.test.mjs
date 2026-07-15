import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellLog } from '../src/shell-log.ts';

const LOG_ENV_KEYS = [
  'AGXP_SHELL_LOG',
  'AGXP_SHELL_LOG_LEVEL',
  'AGXP_SHELL_LOG_MAX_BYTES',
  'AGXP_SHELL_LOG_MAX_FILES',
];

let passed = 0;
let failed = 0;
async function test(name, fn, env = {}) {
  const oldEnv = Object.fromEntries(LOG_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of LOG_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}:`, err);
  } finally {
    for (const key of LOG_ENV_KEYS) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  }
}

function home() {
  return mkdtempSync(join(tmpdir(), 'agxp-shell-log-'));
}

await test('writes JSONL record', () => {
  const h = home();
  const log = new ShellLog({ shell: 'claude', fileBase: 'claude-shell', homeDir: h });
  log.info({ server: 'agxp', component: 'channel', event: 'startup', message: 'started' });
  const body = readFileSync(join(h, 'logs', 'claude-shell.jsonl'), 'utf8');
  const rec = JSON.parse(body.trim());
  assert.equal(rec.shell, 'claude');
  assert.equal(rec.event, 'startup');
  assert.equal(rec.server, 'agxp');
});

await test('off switch disables writes', () => {
  const h = home();
  const log = new ShellLog({ shell: 'claude', fileBase: 'claude-shell', homeDir: h });
  log.info({ component: 'channel', event: 'startup', message: 'started' });
  assert.equal(existsSync(join(h, 'logs', 'claude-shell.jsonl')), false);
}, { AGXP_SHELL_LOG: 'off' });

await test('level gate skips debug at info', () => {
  const h = home();
  const log = new ShellLog({ shell: 'claude', fileBase: 'claude-shell', homeDir: h });
  log.debug({ component: 'channel', event: 'poll_ok', message: 'ok' });
  assert.equal(existsSync(join(h, 'logs', 'claude-shell.jsonl')), false);
}, { AGXP_SHELL_LOG_LEVEL: 'info' });

await test('rotates when file exceeds max bytes', () => {
  const h = home();
  const log = new ShellLog({ shell: 'claude', fileBase: 'claude-shell', homeDir: h });
  for (let i = 0; i < 10; i++) {
    log.info({ component: 'channel', event: 'startup', message: `started-${i}` });
  }
  assert.ok(statSync(join(h, 'logs', 'claude-shell.jsonl')).size > 0);
  assert.ok(existsSync(join(h, 'logs', 'claude-shell.1.jsonl')));
}, { AGXP_SHELL_LOG_MAX_BYTES: '200', AGXP_SHELL_LOG_MAX_FILES: '2' });

console.log(`shell-log: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
