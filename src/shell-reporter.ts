/**
 * Periodic shell-telemetry reporter for the Claude channel.
 *
 * Fires `agxp shell report` UNCONDITIONALLY on a cadence (default 300s) from the
 * plugin's background loop — independent of timeline polls or any other CLI
 * traffic. This makes each report double as a liveness heartbeat: if reports
 * arrive but poll_auto is flat, the loop is alive but polling is broken; if
 * reports stop, the shell/loop itself is down.
 *
 * Mirrors AdvisoryChecker's timer shape (immediate tick + unref'd setInterval;
 * tick() exposed for tests). runReport failures are swallowed so a transient
 * network/auth error can't crash the loop. All logging goes to stderr.
 */
const log = console.error;

export interface ShellReporterConfig {
  /** Shell out `agxp shell report ...`. MUST resolve/reject; rejection is logged, not fatal. */
  runReport: () => Promise<void>;
}

export class ShellReporter {
  private config: ShellReporterConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: ShellReporterConfig) {
    this.config = config;
  }

  start(intervalSec: number): void {
    if (this.running) return;
    this.running = true;
    this.tick().catch(() => {});
    this.intervalId = setInterval(() => {
      this.tick().catch(() => {});
    }, intervalSec * 1000);
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();
    log(`[agxp] shell reporter started (interval=${intervalSec}s)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
  }

  /** One report cycle. Exposed for tests (driven without real timers). Never rejects. */
  async tick(): Promise<void> {
    try {
      await this.config.runReport();
    } catch (err) {
      log(`[agxp] shell report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
