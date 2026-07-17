/**
 * Periodic version-advisory checker for the Claude channel.
 *
 * The agxp CLI, after each invocation, writes <HomeDir>/advisory.json with the
 * latest server version-advisory values it saw (client/skills/plugin ∈
 * "" | "available" | "required"). The plugin shell can't see those HTTP headers
 * directly (it only shells out to agxp), so it reads the file on a poll loop and
 * surfaces a plugin-shell update nudge via a channel event — mirroring how the
 * channel already surfaces `session_required`.
 *
 * Design: decoupled from the TimelinePoller. A standalone setInterval ticks at
 * ADVISORY_CHECK_INTERVAL_SEC (default 600s); each tick reads the file and emits
 * ONLY when the `plugin` field CHANGES (dedupe against lastPluginAdvisory).
 * Transitions to "" never emit but DO update the dedupe state, so a later
 * required/available transition re-emits.
 *
 * The `skills` field (P2) uses the same CHANGE-dedupe shape but, instead of
 * emitting a channel event, runs `agxp skills sync --dir ~/.claude/skills`
 * (config.runSkillsSync). Skills hot-reload via Claude's file-watch is safe,
 * so both "required" AND "available" auto-sync (unlike a shell upgrade, which
 * only nudges). Dedupe is recorded ONLY after the sync resolves — a rejected
 * sync is retried on the next tick rather than marked done. An in-flight guard
 * (skillsSyncInFlight) ensures overlapping ticks don't each spawn a separate
 * `agxp skills sync` (which would race rm/cp on ~/.claude/skills): a tick that
 * finds a sync already pending skips entirely, leaving dedupe to the owner.
 *
 * The advisory is best-effort: readAdvisory() never throws (absent/corrupt →
 * {plugin:''}), and emit failures are caught+logged so a notification error
 * can't crash the loop.
 *
 * All logging goes to stderr (stdout is reserved for the MCP stdio transport).
 */
import { readAdvisory } from './advisory.js';
import { USER_LANGUAGE_RULE } from './lang.js';
import type { ChannelEventType } from './emit.js';

const log = console.error;

export interface AdvisoryCheckerConfig {
  serverName: string;
  /** Emit a channel notification. Mirrors the createEmitter signature. */
  emit: (eventType: ChannelEventType, meta: Record<string, string>, content: string) => Promise<void>;
  /**
   * Run `agxp skills sync --dir ~/.claude/skills` (P2). Invoked when the
   * advisory `skills` field CHANGES to "required" OR "available" — skills
   * hot-reload via file-watch is safe, so unlike the plugin shell we auto-sync
   * on both levels (no shell re-install/restart needed). MUST reject on
   * failure so the caller can retry next tick without deduping a failed sync.
   * Optional: absent → skills advisories are observed but never acted on
   * (used by tests that only care about the plugin branch).
   */
  runSkillsSync?: () => Promise<void>;
}

export class AdvisoryChecker {
  private config: AdvisoryCheckerConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;
  /** Last advisory `plugin` value we acted on. "" = no active nudge. */
  private lastPluginAdvisory = '';
  /**
   * Last advisory `skills` value we successfully synced. "" = nothing synced
   * yet (or advisory cleared, which resets dedupe so a later required/available
   * re-fires). Only updated after a sync resolves — a rejected sync leaves this
   * untouched so the next tick retries instead of silently deduping.
   */
  private lastSkillsAdvisory = '';
  /**
   * In-flight guard for skills sync (P2 codex-r1). True while a
   * `runSkillsSync()` is pending. Without this, two overlapping ticks (start's
   * immediate tick + the first interval tick, or a slow 60s sync vs a short
   * interval) both see `skills !== lastSkillsAdvisory` (dedupe is only set on
   * success) and each spawn a separate `agxp skills sync` — two processes
   * rm/cp'ing the same ~/.claude/skills dir race and corrupt the install.
   * Mirrors Hermes' `_skills_sync_task.done()` guard. Set in try, cleared in
   * finally; success-dedupe stays in the try body (unchanged on failure).
   */
  private skillsSyncInFlight = false;

  constructor(config: AdvisoryCheckerConfig) {
    this.config = config;
  }

  start(intervalSec: number): void {
    if (this.running) return;
    this.running = true;
    // Fire once immediately so a stale advisory surfaces on startup without
    // waiting a full interval, then on the cadence.
    this.tick().catch((err) => log(`[agxp] advisory tick error: ${err instanceof Error ? err.message : String(err)}`));
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => log(`[agxp] advisory tick error: ${err instanceof Error ? err.message : String(err)}`));
    }, intervalSec * 1000);
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();
    log(`[agxp] advisory checker started (interval=${intervalSec}s)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
  }

  /**
   * One poll: read the advisory file and emit on a value CHANGE. Exposed for
   * tests (driven directly without real timers).
   */
  async tick(): Promise<void> {
    let plugin: string;
    let skills: string;
    try {
      const rec = await readAdvisory();
      plugin = rec.plugin ?? '';
      skills = rec.skills ?? '';
    } catch (err) {
      // readAdvisory never throws, but defend the loop regardless.
      log(`[agxp] advisory read error: ${err instanceof Error ? err.message : String(err)}`);
      plugin = '';
      skills = '';
    }

    // ── plugin branch ────────────────────────────────────────────────────
    // Dedupe against lastPluginAdvisory; update state for ANY transition
    // (including to "") so a later required/available re-emits.
    if (plugin !== this.lastPluginAdvisory) {
      this.lastPluginAdvisory = plugin;

      if (plugin === 'required') {
        await this.config.emit(
          'plugin_update_required',
          { server: this.config.serverName },
          [
            `[AGXP_PLUGIN_UPDATE_REQUIRED] server=${this.config.serverName}`,
            USER_LANGUAGE_RULE,
            'AGXP 插件壳版本过低,服务器要求升级。',
            '请运行 `claude plugin marketplace update agxp-marketplace` 后重装插件升级:',
            '  /plugin install agxp@agxp-marketplace',
            '升级后重启 Claude Code 使新版本生效。',
          ].join('\n'),
        );
      } else if (plugin === 'available') {
        await this.config.emit(
          'plugin_update_available',
          { server: this.config.serverName },
          [
            `[AGXP_PLUGIN_UPDATE_AVAILABLE] server=${this.config.serverName}`,
            USER_LANGUAGE_RULE,
            'AGXP 插件壳有新版本可用(非强制)。',
            '建议升级:运行 `claude plugin marketplace update agxp-marketplace` 后重装插件:',
            '  /plugin install agxp@agxp-marketplace',
            '升级后重启 Claude Code 使新版本生效。',
          ].join('\n'),
        );
      }
      // plugin === '' → no emit (dedupe state already updated above).
    }

    // ── skills branch (P2) ───────────────────────────────────────────────
    // skills auto-sync: required OR available both fire `agxp skills sync`
    // (file-watch hot-reload is safe, so unlike the shell we don't gate on
    // "required"). Dedupe ONLY after a successful sync — a rejected sync
    // leaves lastSkillsAdvisory unchanged so the next tick retries instead of
    // being silently marked done. Transition to "" resets dedupe so a later
    // required/available re-fires.
    if (skills === '') {
      this.lastSkillsAdvisory = '';
    } else if (skills !== this.lastSkillsAdvisory) {
      if ((skills === 'required' || skills === 'available')
          && this.config.runSkillsSync
          && !this.skillsSyncInFlight) {
        // In-flight dedupe: a tick already mid-sync owns this advisory value.
        // Skip entirely (no spawn, no dedupe write) — the pending sync will
        // set dedupe on success, or release the flag on failure so the next
        // tick retries. Without this guard, overlapping ticks each spawn a
        // separate `agxp skills sync` and race on ~/.claude/skills.
        this.skillsSyncInFlight = true;
        try {
          await this.config.runSkillsSync();
          this.lastSkillsAdvisory = skills; // dedupe ONLY after a successful sync
          log(`[agxp] skills auto-synced (${skills})`);
        } catch (err) {
          // Leave lastSkillsAdvisory unchanged → retry next tick, don't mark success.
          log(`[agxp] skills sync failed, will retry next tick: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.skillsSyncInFlight = false;
        }
      } else if (this.skillsSyncInFlight) {
        // A sync is in flight for a prior advisory value: skip this tick
        // entirely. Do NOT touch lastSkillsAdvisory — the pending sync owns
        // dedupe (sets it on success, leaves it on failure). If the pending
        // sync fails, the flag releases and a later tick retries this value.
        log(`[agxp] skills sync already in flight; skipping tick`);
      } else {
        // Unknown value (future advisory level we don't recognize): record it
        // so we don't keep re-evaluating, but don't sync.
        this.lastSkillsAdvisory = skills;
      }
    }
  }
}
