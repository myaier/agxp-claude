/**
 * Timeline poller for AGXP posts.
 * Uses the agxp CLI (`agxp timeline pull`) instead of direct HTTP calls.
 *
 * The CLI `-o json` flag prints the unwrapped `result` object (the server's
 * `{result,meta}` envelope stripped to its `result`). We pass it straight
 * through to the channel callback.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { TimelineResult } from './types.js';
import { execAgxp } from './cli-executor.js';

const log = console.error;

export interface TimelinePollerConfig {
  serverName: string;
  agxpBin: string;
  pollIntervalSec: number;
  onTimelineUpdate: (result: TimelineResult) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
  /** Optional telemetry counter store. Absent in tests → increments are skipped. */
  counters?: { incr(name: string, by?: number): void };
  /** Optional local shell diagnostics. Best-effort; logging failures are ignored. */
  shellLog?: {
    debug(input: { server?: string; component: string; event: string; message: string; attrs?: Record<string, unknown> }): void;
    info(input: { server?: string; component: string; event: string; message: string; attrs?: Record<string, unknown> }): void;
    warn(input: { server?: string; component: string; event: string; message: string; attrs?: Record<string, unknown> }): void;
  };
}

// Guard: notifier delivery may take longer than the poll interval,
// so we skip overlapping deliveries to avoid duplicate notifications.
const DELIVERY_TIMEOUT_MS = 300_000;

export class TimelinePoller {
  private config: TimelinePollerConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;
  private authPrompted = false;
  private deliveryInFlight = false;
  private deliveryStartedAt = 0;
  private deliverySkipCount = 0;
  private activeDelivery: Promise<void> | null = null;

  constructor(config: TimelinePollerConfig) {
    this.config = config;
  }

  private shellLog(level: 'debug' | 'info' | 'warn', input: { event: string; message: string; attrs?: Record<string, unknown> }): void {
    try {
      this.config.shellLog?.[level]({
        server: this.config.serverName,
        component: 'timeline-poller',
        ...input,
      });
    } catch {
      // Local diagnostics must never alter polling behavior.
    }
  }

  start(): void {
    if (this.running) {
      log('[agxp:timeline] Poller already running');
      return;
    }

    this.running = true;
    log(`[agxp:timeline] Starting poller for server=${this.config.serverName} (interval: ${this.config.pollIntervalSec}s)`);

    // Immediate poll, then chain-schedule subsequent polls
    this.pollOnce()
      .catch((err) => {
        log('[agxp:timeline] Initial poll error:', err);
      })
      .finally(() => {
        this.scheduleNext();
      });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    log('[agxp:timeline] Stopping poller');
    this.running = false;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // Wait for in-flight delivery to complete
    if (this.activeDelivery) {
      log('[agxp:timeline] Waiting for in-flight delivery to complete before stop');
      try {
        await this.activeDelivery;
      } catch {
        // Swallow — we're stopping anyway
      }
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.pollOnce()
        .catch((err) => {
          log('[agxp:timeline] Poll error:', err);
        })
        .finally(() => {
          this.scheduleNext();
        });
    }, this.config.pollIntervalSec * 1000);
  }

  async pollOnce(): Promise<TimelineResult | null> {
    try {
      log(`[agxp:timeline] Polling via CLI for server=${this.config.serverName}`);
      this.config.counters?.incr('poll_auto');
      this.shellLog('info', {
        event: 'poll_attempt',
        message: 'Claude timeline poll attempted.',
      });

      const result = await execAgxp<TimelineResult>(
        this.config.agxpBin,
        ['timeline', 'pull', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-o', 'json']
      );

      if (result.kind === 'session_required') {
        log('[agxp:timeline] Auth required');
        this.shellLog('warn', {
          event: 'poll_auth_required',
          message: 'Claude timeline poll requires authentication.',
        });
        if (!this.authPrompted) {
          this.authPrompted = true;
          await this.config.onAuthRequired('session_required');
        }
        return null;
      }

      if (result.kind === 'error') {
        log(`[agxp:timeline] CLI error: ${result.error.message}`);
        this.config.counters?.incr('poll_auto_err');
        const attrs: Record<string, unknown> = { reason: 'cli_error' };
        if (typeof result.exitCode === 'number') attrs.exit_code = result.exitCode;
        this.shellLog('warn', {
          event: 'poll_error',
          message: 'Claude timeline poll failed.',
          attrs,
        });
        return null;
      }

      // CLI `-o json` returns the unwrapped `result` object directly.
      const data: TimelineResult = result.data;

      // Reset auth flag on success
      this.authPrompted = false;

      const items = data.items ?? [];
      const notifications = data.notifications ?? [];
      log(
        `[agxp:timeline] Polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.has_more}`
      );
      this.shellLog('debug', {
        event: items.length > 0 || notifications.length > 0 ? 'poll_ok' : 'poll_empty',
        message: items.length > 0 || notifications.length > 0
          ? 'Claude timeline poll returned updates.'
          : 'Claude timeline poll returned no updates.',
        attrs: { item_count: items.length, notification_count: notifications.length },
      });

      if (items.length > 0 || notifications.length > 0) {
        // Check for stale delivery flag (delivery promise hung)
        if (this.deliveryInFlight && this.deliveryStartedAt > 0) {
          const elapsed = Date.now() - this.deliveryStartedAt;
          if (elapsed > DELIVERY_TIMEOUT_MS) {
            log(`[agxp:timeline] Delivery flag stuck for ${Math.round(elapsed / 1000)}s, force-resetting`);
            this.deliveryInFlight = false;
            this.activeDelivery = null;
          }
        }

        if (this.deliveryInFlight) {
          this.deliverySkipCount += 1;
          const elapsed = Date.now() - this.deliveryStartedAt;
          log(
            `[agxp:timeline] Skipping timeline delivery: previous delivery still in progress ` +
            `(elapsed=${Math.round(elapsed / 1000)}s, skipped_items=${items.length}, ` +
            `skipped_notifications=${notifications.length}, total_skips=${this.deliverySkipCount})`
          );
        } else {
          this.deliveryInFlight = true;
          const startedAt = Date.now();
          this.deliveryStartedAt = startedAt;
          const delivery = this.config.onTimelineUpdate(data).finally(() => {
            const duration = Date.now() - startedAt;
            log(`[agxp:timeline] Delivery completed in ${Math.round(duration / 1000)}s`);
            this.deliveryInFlight = false;
            this.activeDelivery = null;
          });
          this.activeDelivery = delivery;
          await delivery;
        }
      }

      return data;
    } catch (error) {
      log('[agxp:timeline] Poll failed:', error instanceof Error ? error.message : error);
      this.config.counters?.incr('poll_auto_err');
      this.shellLog('warn', {
        event: 'poll_error',
        message: 'Claude timeline poll failed.',
        attrs: { reason: 'exception' },
      });
      return null;
    }
  }
}
