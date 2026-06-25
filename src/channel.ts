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
import { CONFIG } from './config.js';
import { TimelinePoller } from './timeline-poller.js';
import { EventStreamClient } from './event-stream.js';
import { IdentityRefresher } from './identity-refresher.js';
import { routeEvent } from './event-router.js';
import { createEmitter } from './emit.js';
import { resolveStartupDelayMs } from './startup-delay.js';

// Stderr is captured by the MCP client (e.g. Claude Code stores it per-session
// under ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/), so
// we just log there directly — no file logger of our own.
const log = console.error;

async function markMessagesRead(serverName: string, messageIds: string[]): Promise<boolean> {
  if (!messageIds || messageIds.length === 0) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const args = ['thread', 'read', '--messages', messageIds.join(','), '-s', serverName, '--no-interactive'];

    // stdio: stdout ignored (its output would corrupt the MCP stdio channel,
    // which is reserved for protocol messages, and an undrained pipe deadlocks
    // the child once the OS buffer fills); stderr inherited so CLI diagnostics
    // flow to our stderr log channel.
    const proc = spawn(CONFIG.AGXP_BIN, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      // Guard against a wedged CLI: kill after 10s so a hung mark can never
      // stall the stream's event handling indefinitely.
      timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      // spawn emits 'error' (not 'close') on ENOENT etc.; without this listener
      // the promise would never settle and the await would hang forever.
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => resolve(code ?? -1));
    });

    if (exitCode === 0) {
      log(`[agxp] Marked ${messageIds.length} message(s) as read`);
      return true;
    } else {
      log(`[agxp] Failed to mark messages as read (exit code ${exitCode})`);
      return false;
    }
  } catch (error: unknown) {
    log(`[agxp] Failed to mark messages as read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markMatchesRead(serverName: string, subscriptionId: string, matchIds: string[]): Promise<boolean> {
  if (!matchIds || matchIds.length === 0 || !subscriptionId) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const args = ['subscription', 'read', '--sub', subscriptionId, '--matches', matchIds.join(','), '-s', serverName, '--no-interactive'];

    // stdio: stdout ignored (its output would corrupt the MCP stdio channel,
    // which is reserved for protocol messages, and an undrained pipe deadlocks
    // the child once the OS buffer fills); stderr inherited so CLI diagnostics
    // flow to our stderr log channel.
    const proc = spawn(CONFIG.AGXP_BIN, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      // Guard against a wedged CLI: kill after 10s so a hung mark can never
      // stall the stream's event handling indefinitely.
      timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      // spawn emits 'error' (not 'close') on ENOENT etc.; without this listener
      // the promise would never settle and the await would hang forever.
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => resolve(code ?? -1));
    });

    if (exitCode === 0) {
      log(`[agxp] Marked ${matchIds.length} match(es) as read`);
      return true;
    } else {
      log(`[agxp] Failed to mark matches as read (exit code ${exitCode})`);
      return false;
    }
  } catch (error: unknown) {
    log(`[agxp] Failed to mark matches as read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markContactEventsRead(serverName: string, requestIds: string[]): Promise<boolean> {
  if (!requestIds || requestIds.length === 0) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const args = ['contact', 'events', 'ack', '--ids', requestIds.join(','), '-s', serverName, '--no-interactive'];

    // stdio: stdout ignored (its output would corrupt the MCP stdio channel,
    // which is reserved for protocol messages, and an undrained pipe deadlocks
    // the child once the OS buffer fills); stderr inherited so CLI diagnostics
    // flow to our stderr log channel.
    const proc = spawn(CONFIG.AGXP_BIN, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      // Guard against a wedged CLI: kill after 10s so a hung mark can never
      // stall the stream's event handling indefinitely.
      timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      // spawn emits 'error' (not 'close') on ENOENT etc.; without this listener
      // the promise would never settle and the await would hang forever.
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => resolve(code ?? -1));
    });

    if (exitCode === 0) {
      log(`[agxp] Marked ${requestIds.length} contact event(s) as read`);
      return true;
    } else {
      log(`[agxp] Failed to mark contact events as read (exit code ${exitCode})`);
      return false;
    }
  } catch (error: unknown) {
    log(`[agxp] Failed to mark contact events as read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markCommitmentsRead(serverName: string, pactIds: string[]): Promise<boolean> {
  if (!pactIds || pactIds.length === 0) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const args = ['scenario', 'ack', '--pacts', pactIds.join(','), '-s', serverName, '--no-interactive'];

    // stdio: stdout ignored (its output would corrupt the MCP stdio channel,
    // which is reserved for protocol messages, and an undrained pipe deadlocks
    // the child once the OS buffer fills); stderr inherited so CLI diagnostics
    // flow to our stderr log channel.
    const proc = spawn(CONFIG.AGXP_BIN, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      // Guard against a wedged CLI: kill after 10s so a hung mark can never
      // stall the stream's event handling indefinitely.
      timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      // spawn emits 'error' (not 'close') on ENOENT etc.; without this listener
      // the promise would never settle and the await would hang forever.
      proc.on('error', (err) => reject(err));
      proc.on('close', (code: number | null) => resolve(code ?? -1));
    });

    if (exitCode === 0) {
      log(`[agxp] Marked ${pactIds.length} commitment(s) as read`);
      return true;
    } else {
      log(`[agxp] Failed to mark commitments as read (exit code ${exitCode})`);
      return false;
    }
  } catch (error: unknown) {
    log(`[agxp] Failed to mark commitments as read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
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
Credentials are missing or expired. Trigger the agxp-identity skill and run
\`agxp session start --email <email>\` (the CLI owns credentials).

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
    await emit(
      'session_required',
      { reason },
      JSON.stringify({
        reason,
        action: `Run 'agxp session start --email <email> -s ${CONFIG.AGXP_SERVER}' to authenticate.`,
      }),
    );
  },
});

eventStreamClient = new EventStreamClient({
  serverName: CONFIG.AGXP_SERVER,
  agxpBin: CONFIG.AGXP_BIN,
  async onEvent(event) {
    await routeEvent(event, {
      emit,
      markMessagesRead: (ids) => markMessagesRead(CONFIG.AGXP_SERVER, ids),
      markMatchesRead: (subId, ids) => markMatchesRead(CONFIG.AGXP_SERVER, subId, ids),
      markContactEventsRead: (ids) => markContactEventsRead(CONFIG.AGXP_SERVER, ids),
      markCommitmentsRead: (ids) => markCommitmentsRead(CONFIG.AGXP_SERVER, ids),
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

timelinePoller.start();
eventStreamClient.start();
identityRefresher.start();

async function shutdown(signal: string) {
  log(`[agxp] ${signal}`);
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
