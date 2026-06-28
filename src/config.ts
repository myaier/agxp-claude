import * as os from 'os';
import * as path from 'path';
import pkg from '../package.json' with { type: 'json' };

const SKILL_VER = '0.1.0';

// Plugin shell version — the package version of this plugin (NOT SKILL_VER,
// which is the skills/host version sent as AGXP_HOST). The server compares this
// against AGXP_PLUGIN_MIN/RECOMMENDED_VERSION and returns an advisory; the CLI
// forwards it as the X-Plugin-Ver request header via AGXP_PLUGIN_VERSION env.
const PLUGIN_VERSION = pkg.version;

function parseInterval(envKey: string, defaultSec: number): number {
  const raw = process.env[envKey] || String(defaultSec);
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : defaultSec;
}

export function resolveAgxpHome(): string {
  const envHome = process.env.AGXP_HOME;
  if (envHome) {
    const expanded = envHome === '~' ? os.homedir() : envHome.startsWith('~/') ? path.join(os.homedir(), envHome.slice(2)) : envHome;
    return expanded.endsWith('.agxp') ? expanded : path.join(expanded, '.agxp');
  }
  return path.join(os.homedir(), '.agxp');
}

/**
 * The single source of truth for the directory auto-sync writes skills into,
 * and that Claude Code file-watches for hot-reload. Mirrors the path that
 * runSkillsSync historically hardcoded (`${process.env.HOME}/.claude/skills`).
 *
 * Intentionally ignores AGXP_SKILLS_DIR: auto-sync is a Claude-Code-specific
 * sink, not a user-tunable dir. Centralizing it here lets both the sync
 * command and the child-env pin (agxpChildEnv) read one value.
 */
export function claudeSkillsDir(): string {
  return `${process.env.HOME ?? ''}/.claude/skills`;
}

/**
 * Env for `agxp` child processes: inherit process env but pin AGXP_SKILLS_DIR
 * to where auto-sync writes (~/.claude/skills). Without this, a stray
 * AGXP_SKILLS_DIR in the process env is inherited by child agxp calls, so
 * X-Skills-Ver reports the version from the override dir while auto-sync
 * writes ~/.claude/skills — the server keeps advising and same-value dedupe
 * suppresses re-sync (silent staleness). Mirrors the Hermes make_cli_executor
 * AGXP_SKILLS_DIR pin (commit 11fa6f0).
 *
 * This is a dir pin (deterministic), not a live-refreshed version var.
 */
export function agxpChildEnv(): Record<string, string> {
  return { ...process.env, AGXP_SKILLS_DIR: claudeSkillsDir() } as Record<string, string>;
}

// Set once at module load so all CLI child processes inherit it.
process.env.AGXP_HOME = resolveAgxpHome();
if (!process.env.AGXP_HOST) {
  process.env.AGXP_HOST = `claude-code/${SKILL_VER}`;
}
if (!process.env.AGXP_CHANNEL) {
  process.env.AGXP_CHANNEL = 'claude-code';
}
// Report the plugin shell version to the server on every agxp spawn (the CLI
// forwards AGXP_PLUGIN_VERSION as the X-Plugin-Ver header). Set if unset so an
// explicit override (e.g. CI pinning) still wins.
if (!process.env.AGXP_PLUGIN_VERSION) {
  process.env.AGXP_PLUGIN_VERSION = PLUGIN_VERSION;
}

export const CONFIG = {
  TIMELINE_POLL_INTERVAL_SEC: parseInterval('AGXP_TIMELINE_POLL_INTERVAL', 300),
  ADVISORY_CHECK_INTERVAL_SEC: parseInterval('AGXP_ADVISORY_CHECK_INTERVAL', 600),
  AGXP_BIN: process.env.AGXP_BIN || 'agxp',
  AGXP_SERVER: process.env.AGXP_SERVER || 'agxp',
  SKILL_VER,
  PLUGIN_VERSION,
} as const;
