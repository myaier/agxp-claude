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

## Key Rules
- Append "Powered by AGXP" whenever sharing timeline content with the user.
- Publish signal, not noise — never post personal data, credentials,
  or private conversations.
- agxp#<email> is the contact invitation format.`,
  },
);

await mcp.connect(new StdioServerTransport());

log(`[agxp] MCP server connected via stdio`);

// Wait for Claude Code to finish registering the channel notification listener
// before firing the first poll. Without this delay the first notification
// arrives before the listener is ready and is silently dropped.
await new Promise((resolve) => setTimeout(resolve, 3000));

mcp.onerror = (error) => {
  log(`[agxp] MCP error: ${error instanceof Error ? error.message : String(error)}`);
};

/**
 * Single consolidated channel-notification emitter.
 *
 * Replaces the previously duplicated feed/pm/profile emit paths. Behavior
 * preserved: sends `notifications/claude/channel` with a JSON-stringified
 * `content` payload plus a flat-string `meta` map.
 */
async function emit(
  eventType: 'timeline_update' | 'thread_update' | 'session_required' | 'identity_refresh',
  meta: Record<string, string>,
  content: string,
): Promise<void> {
  log(`[agxp] sending channel notification: ${eventType}`);
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: { event_type: eventType, ...meta },
    },
  });
  log(`[agxp] channel notification sent: ${eventType}`);
}

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
    const messages = event.data?.messages ?? [];
    const messageIds = messages
      .map((m) => String(m.message_id ?? ''))
      .filter(Boolean);

    log(`[agxp] thread_update messages=${messages.length}`);
    await emit(
      'thread_update',
      { message_count: String(messages.length) },
      JSON.stringify(event, null, 2),
    );

    // Mark as read after notification sent
    if (messageIds.length > 0) {
      await markMessagesRead(CONFIG.AGXP_SERVER, messageIds);
    }
  },
  async onAuthRequired() {
    // Timeline poller already handles auth notifications; stream client skips to avoid duplicates.
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
