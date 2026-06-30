/**
 * Stream client for AGXP thread/event updates.
 * Manages a long-running `agxp event watch` child process that outputs NDJSON.
 *
 * P1 (event-render-CLI): the child is spawned with `-o agent`, so each NDJSON
 * line is a RENDERED Block `{type, agent_block?, meta?, ack_token?}` — the CLI
 * owns all per-type rendering + ack_token encoding. The shell is a forwarder:
 * it passes each Block straight to `onEvent`, which (in channel.ts) emits
 * `agent_block` to the MCP channel and, only after a successful emit, acks via
 * `agxp event ack <token>`. The CLI also owns the reconnect checkpoint (it
 * tracks `data.next_checkpoint` from the raw server frame internally and
 * resumes via `?checkpoint=` on its own reconnect loop), so the shell no longer
 * extracts or re-passes a checkpoint.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import { agxpChildEnv } from './config.js';
import type { RenderedBlock } from './event-router.js';

const log = console.error;

const EXIT_AUTH_REQUIRED = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const STOP_GRACE_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 20;

export interface EventStreamClientConfig {
  serverName: string;
  agxpBin: string;
  onEvent: (block: RenderedBlock) => Promise<void>;
  onAuthRequired: () => Promise<void>;
  /** Fired once when the stream gives up after MAX_CONSECUTIVE_FAILURES.
   * Claude can't run an autonomous REST fallback loop (no MCP turn available
   * without an agent invocation), so this only SURFACES the loss — the agent
   * must poll manually (spec §6.1). */
  onConnectionLost?: () => Promise<void>;
}

export class EventStreamClient {
  private config: EventStreamClientConfig;
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private stopping = false;
  private running = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(config: EventStreamClientConfig) {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      log('[agxp:event] Stream client already running');
      return;
    }

    this.running = true;
    this.stopping = false;
    log(`[agxp:event] Starting stream client for server=${this.config.serverName}`);
    this.spawnStreamProcess();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    log('[agxp:event] Stopping stream client');
    this.stopping = true;
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.child) {
      const child = this.child;
      this.child = null;

      child.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited
          }
          resolve();
        }, STOP_GRACE_MS);

        child.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }
  }

  private spawnStreamProcess(): void {
    if (this.stopping || !this.running) {
      return;
    }

    const args = ['event', 'watch', '-s', this.config.serverName, '-o', 'agent'];

    log(`[agxp:event] Spawning: ${this.config.agxpBin} ${args.join(' ')}`);

    const child = spawn(this.config.agxpBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agxpChildEnv(),
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    this.readline = rl;

    rl.on('line', (line) => {
      this.handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log(`[agxp:event] stderr: ${text}`);
      }
    });

    child.on('error', (err) => {
      log(`[agxp:event] Process error: ${err.message}`);
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      log(`[agxp:event] Process exited (code=${code}, signal=${signal})`);

      if (this.stopping) {
        return;
      }

      if (code === EXIT_AUTH_REQUIRED) {
        log('[agxp:event] Auth required');
        this.config.onAuthRequired().then(() => {
          this.scheduleRestart();
        }).catch((err) => {
          log(`[agxp:event] Auth handler error: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart();
        });
        return;
      }

      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const block = JSON.parse(trimmed) as RenderedBlock;

      // Reset backoff on successful parse
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.consecutiveFailures = 0;

      this.config.onEvent(block).catch((err) => {
        log(`[agxp:event] Event handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      log(`[agxp:event] Failed to parse line: ${(err as Error).message}`);
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.running) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`[agxp:event] Giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      // Surface the loss to the agent (manual fallback — Claude can't poll
      // autonomously without an MCP-driven turn). Fire-and-forget.
      this.config.onConnectionLost?.().catch((err) => {
        log(`[agxp:event] Connection-lost handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.running = false;
      return;
    }

    log(`[agxp:event] Reconnecting in ${this.backoffMs}ms (failure #${this.consecutiveFailures})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnStreamProcess();
    }, this.backoffMs);

    this.backoffMs = Math.min(
      this.backoffMs * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS
    );
  }
}
