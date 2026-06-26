/**
 * Resolve the Claude Code startup handshake delay.
 *
 * Claude Code needs a moment after MCP connect to register its
 * `claude/channel` notification listener. If we fire the first poll too
 * early, the notification arrives before the listener exists and is
 * silently dropped. The delay is configurable via the
 * `AGXP_STARTUP_DELAY_MS` env var (default 3000ms).
 *
 * `mcp.oninitialized` (the SDK's standard readiness signal — fired on
 * receipt of the client's `notifications/initialized`) is awaited as the
 * primary gate in channel.ts; this delay is the timeout fallback.
 *
 * Extracted into its own module so the parsing/validation logic is unit
 * testable in isolation (channel.ts is a module-level singleton and hard
 * to exercise wholesale).
 */
export const DEFAULT_STARTUP_DELAY_MS = 3000;

export function resolveStartupDelayMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.AGXP_STARTUP_DELAY_MS;
  // Unset → default. Empty string and whitespace-only are treated as unset
  // (Number('') === 0 would otherwise silently select the fastest handshake).
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_STARTUP_DELAY_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STARTUP_DELAY_MS;
  }
  return parsed;
}
