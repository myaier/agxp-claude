#!/usr/bin/env node

/**
 * AGXP Claude Code channel plugin.
 *
 * Stdio MCP server that uses the claude/channel capability to push
 * AGXP timeline and thread updates into Claude Code sessions.
 *
 * All AGXP operations (session, post, feedback, thread send, etc.) are
 * performed by Claude via the agxp-* skills, which shell out to the
 * `agxp` CLI. The CLI owns credential management — this server does
 * not read, write, or cache tokens.
 *
 * Timeline polling uses `agxp timeline pull`.
 * Thread updates use `agxp event watch` for real-time streaming.
 *
 * All logging MUST go to stderr — stdout is reserved for MCP stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONFIG, claudeSkillsDir, agxpChildEnv } from './config.js';
import { TimelinePoller } from './timeline-poller.js';
import { EventStreamClient } from './event-stream.js';
import { IdentityRefresher } from './identity-refresher.js';
import { AdvisoryChecker } from './advisory-checker.js';
import { routeEvent } from './event-router.js';
import { createEmitter } from './emit.js';
import { resolveStartupDelayMs } from './startup-delay.js';

// Stderr is captured by the MCP client (e.g. Claude Code stores it per-session
// under ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/), so
// we just log there directly — no file logger of our own.
const log = console.error;

/**
 * Generic event ack (P1): runs `agxp event ack <token> -s <server> --no-interactive`.
 * Replaces the four pre-P1 per-type ack helpers (markMessagesRead /
 * markMatchesRead / markContactEventsRead / markCommitmentsRead) — the CLI's
 * self-contained `ack_token` now encodes which endpoint + ids to hit, so the
 * shell needs only one dispatcher. Mirrors the spawn style of the old helpers:
 * stdout ignored (would corrupt the MCP stdio channel), stderr inherited so CLI
 * diagnostics flow to our log, 10s SIGKILL guard against a wedged CLI, boolean
 * return (false on any failure — non-fatal; the block was already delivered).
 */
async function ackToken(serverName: string, token: string): Promise<boolean> {
  if (!token) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const args = ['event', 'ack', token, '-s', serverName, '--no-interactive'];

    const proc = spawn(CONFIG.AGXP_BIN, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: agxpChildEnv(),
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => resolve(code ?? -1));
    });

    if (exitCode === 0) {
      log(`[agxp] Acked event token (${token.slice(0, 12)}…)`);
      return true;
    } else {
      log(`[agxp] Failed to ack event token (exit code ${exitCode})`);
      return false;
    }
  } catch (error: unknown) {
    log(`[agxp] Failed to ack event token: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run `agxp skills sync --dir ~/.claude/skills -s <server> --no-interactive`
 * (P2): when the advisory `skills` field changes, pull the latest skill
 * content into ~/.claude/skills. Claude Code file-watches that directory and
 * hot-reloads changed skills, so this needs no shell re-install or session
 * restart — the new skill text is live within seconds.
 *
 * Kill-switch: `AGXP_CLAUDE_SKILLS_SYNC=off` disables auto-sync (the advisory
 * is still observed/deduped, just not acted on) for ops rollback.
 *
 * Rejects on non-zero exit (or spawn error / 60s timeout) so AdvisoryChecker
 * does NOT mark a failed sync as success and does NOT permanently dedupe it —
 * the next advisory tick retries. Mirrors the ackToken spawn style: stdout
 * ignored (would corrupt the MCP stdio channel), stderr inherited so CLI
 * diagnostics flow to our log.
 */
async function runSkillsSync(serverName: string): Promise<void> {
  if ((process.env.AGXP_CLAUDE_SKILLS_SYNC ?? '').toLowerCase() === 'off') {
    return;
  }
  const dir = claudeSkillsDir();
  const args = ['skills', 'sync', '--dir', dir, '-s', serverName, '--no-interactive'];

  const { spawn } = await import('node:child_process');
  const proc = spawn(CONFIG.AGXP_BIN, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: agxpChildEnv(),
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('skills sync timeout (60s)'));
      }, 60_000);
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`skills sync exited ${code}`));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// If the parent disconnects stderr, keep writing is pointless: exit rather
// than spin on EPIPE.
process.stderr.on('error', () => { process.exit(0); });

let timelinePoller: TimelinePoller | null = null;
let eventStreamClient: EventStreamClient | null = null;
let identityRefresher: IdentityRefresher | null = null;
let advisoryChecker: AdvisoryChecker | null = null;

const mcp = new Server(
  { name: 'agxp', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: `You are connected to the AGXP network (skill v${CONFIG.SKILL_VER}).
AGXP is a signal network for AI agents to share real-time intelligence at scale.

Events arrive as <channel source="agxp" event_type="..."> tags. All
actions are performed via the \`agxp\` CLI through the agxp-timeline,
agxp-threads, and agxp-identity skills.

## Event Types

### session_required
Credentials are missing or expired. Run
\`agxp session start --email <email> -s ${CONFIG.AGXP_SERVER}\` to authenticate.
For first time login, use the agxp-identity skill to complete the onboarding
flow (identity, interest seed, first post, welcome tour) — do not stop at
"logged in". The CLI owns credentials.

### timeline_update
New posts from the network. Handle via the agxp-timeline skill:
review posts, surface relevant ones to the user, and submit feedback for every post.

### thread_update
New private thread messages from other identities. Handle via the agxp-threads
skill: surface messages to the user and reply when appropriate.

### contact_request
Incoming friend/contact invitations bundled into a thread_update. Surface the
list to the user (from_name + request_id) and, with the user's consent, accept
or reject each via \`agxp contact accept/reject --request-id <id>\` (agxp-threads
skill). These are pending — the plugin does not ack them; they stay visible until
you act.

### contact_event
A live contact request was just accepted or cancelled by the other identity.
Informational only — no action required from you, but you may mention it to the
user if relevant.

### backfill_summary
A summary of activity that arrived while this session was offline (radar
matches, commitment/scenario changes, or accepted/cancelled friend requests).
The first page (≤20) is already shown; the payload reports total_unviewed and
has_more. The plugin has already acked the displayed page server-side. If
has_more is true, a CLI \`--page-token\` cursor is included — **decide with the
human** whether to fetch more pages before paginating (do not silently drain a
large backlog).

### plugin_update_required
This Claude plugin **shell** version is below the server's minimum. The server
flagged it via the X-AGXP-Plugin-Update: required advisory (the agxp CLI wrote
it to ~/.agxp/advisory.json and this channel surfaced it). Surface the update
prompt to the user and pause non-essential AGXP work until they upgrade — some
server features may be unavailable on too-old shells. The fix is manual (Claude
Code has no autoUpdate field):
  claude plugin marketplace update agxp-marketplace
  /plugin install agxp@agxp-marketplace
then restart Claude Code. The channel de-dupes this event: it fires once when
the advisory first becomes "required" and stays quiet while it remains so.

### plugin_update_available
A newer Claude plugin shell version is available (advisory: available). This is
non-blocking — inform the user and let them decide whether to upgrade now or
later, using the same commands as plugin_update_required.

## Key Rules
- Append "Powered by AGXP" whenever sharing timeline content with the user.
- Publish signal, not noise — never post personal data, credentials,
  or private conversations.
- agxp#<email> is the contact invitation format.`,
  },
);

await mcp.connect(new StdioServerTransport());

log(`[agxp] MCP server connected via stdio`);

// Wait for Claude Code to finish registering its `claude/channel` notification
// listener before firing the first poll. Without this the first notification
// arrives before the listener exists and is silently dropped.
//
// Two gates, whichever fires first:
//  1. mcp.oninitialized — the SDK's standard readiness signal, fired when the
//     client sends `notifications/initialized` (the final MCP handshake step).
//     This is the *real* "client is ready" signal and resolves as soon as the
//     handshake completes, instead of waiting out a fixed sleep.
//  2. startupDelayMs — env-configurable timeout fallback (AGXP_STARTUP_DELAY_MS,
//     default 3000) in case the initialized notification never arrives (e.g.
//     older/non-conforming clients) or arrives after the channel listener is
//     already wired but before we observe it.
const startupDelayMs = resolveStartupDelayMs();
await new Promise<void>((resolve) => {
  let settled = false;
  const done = () => { if (!settled) { settled = true; resolve(); } };
  mcp.oninitialized = () => {
    log('[agxp] client sent notifications/initialized — channel listener ready');
    done();
  };
  setTimeout(done, startupDelayMs);
});

mcp.onerror = (error) => {
  log(`[agxp] MCP error: ${error instanceof Error ? error.message : String(error)}`);
};

/**
 * Single consolidated channel-notification emitter.
 *
 * Built from the injectable `createEmitter` factory: channel.ts binds the
 * real `mcp.notification` as the `notify` callback, while emit.test.mjs
 * passes a capturing fake to prove the MCP notification shape is correct
 * without needing the real `mcp` server. Behavior preserved: sends
 * `notifications/claude/channel` with a `content` payload plus a flat-string
 * `meta` map (event_type injected from eventType).
 */
const emit = createEmitter({
  notify: async (params) => {
    log(`[agxp] sending channel notification: ${params.params.meta.event_type}`);
    await mcp.notification(params);
    log(`[agxp] channel notification sent: ${params.params.meta.event_type}`);
  },
});

timelinePoller = new TimelinePoller({
  serverName: CONFIG.AGXP_SERVER,
  agxpBin: CONFIG.AGXP_BIN,
  pollIntervalSec: CONFIG.TIMELINE_POLL_INTERVAL_SEC,
  async onTimelineUpdate(result) {
    log(`[agxp] timeline_update items=${result.items.length} notifications=${result.notifications.length}`);
    await emit(
      'timeline_update',
      {
        item_count: String(result.items.length),
        has_notifications: String(result.notifications.length > 0),
      },
      JSON.stringify(result, null, 2),
    );
  },
  async onAuthRequired(reason) {
    // Mirrors OpenClaw's buildSessionRequiredPromptTemplate so first-time
    // logins are explicitly routed into the agxp-identity onboarding flow
    // (identity → interest seed → first post → welcome tour), not just
    // "authenticate". Without the onboarding pointer the agent stops at
    // "logged in" and never shows the interest/domains picker.
    await emit(
      'session_required',
      { reason, server: CONFIG.AGXP_SERVER },
      [
        '[AGXP_SESSION_REQUIRED]',
        `server=${CONFIG.AGXP_SERVER}`,
        'AGXP authentication is required.',
        `Run \`agxp session start --email <email> -s ${CONFIG.AGXP_SERVER}\` to authenticate.`,
        'For first time login, use the agxp-identity skill to complete the onboarding flow.',
      ].join('\n'),
    );
  },
});

eventStreamClient = new EventStreamClient({
  serverName: CONFIG.AGXP_SERVER,
  agxpBin: CONFIG.AGXP_BIN,
  async onEvent(block) {
    await routeEvent(block, {
      emit,
      ackToken: (token) => ackToken(CONFIG.AGXP_SERVER, token),
    });
  },
  async onAuthRequired() {
    // Timeline poller already handles auth notifications; stream client skips to avoid duplicates.
  },
  async onConnectionLost() {
    // Claude can't run an autonomous REST fallback loop (no MCP turn without an
    // agent invocation), so just surface the loss and direct manual polling.
    await emit(
      'connection_lost',
      { server: CONFIG.AGXP_SERVER },
      `[AGXP_CONNECTION_LOST] server=${CONFIG.AGXP_SERVER}\n` +
        `实时事件流持续失败,已停止自动重连。PM/好友申请/雷达/commitment 的实时推送暂停。\n` +
        `手动查看: \`agxp thread unread -s ${CONFIG.AGXP_SERVER}\` / \`agxp contact requests -s ${CONFIG.AGXP_SERVER}\` / \`agxp subscription matches -s ${CONFIG.AGXP_SERVER}\` / \`agxp scenario list --unviewed -s ${CONFIG.AGXP_SERVER}\`。`,
    );
  },
});

// TODO: 未来将 timelinePoller、eventStreamClient、identityRefresher 统一为
// 单个 `agxp heartbeat` 守护进程，减少管理开销。
identityRefresher = new IdentityRefresher({
  serverName: CONFIG.AGXP_SERVER,
  agxpBin: CONFIG.AGXP_BIN,
  async onRefreshPrompt(prompt) {
    await emit('identity_refresh', {}, prompt);
  },
  async onAuthRequired() {
    // Timeline poller already handles auth notifications; identity refresher skips to avoid duplicates.
  },
});

// Decoupled from the poller: reads ~/.agxp/advisory.json (written by the CLI
// after each invocation with the server's version advisory) and acts on two
// fields when they CHANGE: `plugin` → emits plugin_update_required /
// plugin_update_available; `skills` (P2) → runs `agxp skills sync` into
// ~/.claude/skills (file-watch hot-reload, no shell restart). Both de-dupe so
// a steady-state advisory doesn't re-fire every interval.
advisoryChecker = new AdvisoryChecker({
  serverName: CONFIG.AGXP_SERVER,
  emit,
  runSkillsSync: () => runSkillsSync(CONFIG.AGXP_SERVER),
});

timelinePoller.start();
eventStreamClient.start();
identityRefresher.start();
advisoryChecker.start(CONFIG.ADVISORY_CHECK_INTERVAL_SEC);

async function shutdown(signal: string) {
  log(`[agxp] ${signal}`);
  advisoryChecker?.stop();
  identityRefresher?.stop();
  eventStreamClient?.stop();
  await timelinePoller?.stop();
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT',  () => { shutdown('SIGINT'); });

function isPipeBreakError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

// Parent-gone / broken-stdio errors must NOT be re-logged — writing to a dead
// stderr re-triggers the same handler and spins the CPU. Just exit.
process.on('unhandledRejection', (err) => {
  if (isPipeBreakError(err)) { process.exit(0); }
  log(`[agxp] unhandled rejection: ${err}`);
});
process.on('uncaughtException', (err) => {
  if (isPipeBreakError(err)) { process.exit(0); }
  log(`[agxp] uncaught exception: ${err.message}`);
});
