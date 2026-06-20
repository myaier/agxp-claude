import * as os from 'os';
import * as path from 'path';

const SKILL_VER = '0.1.0';

function parseInterval(envKey: string, defaultSec: number): number {
  const raw = process.env[envKey] || String(defaultSec);
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : defaultSec;
}

function resolveAgxpHome(): string {
  const envHome = process.env.AGXP_HOME;
  if (envHome) {
    const expanded = envHome === '~' ? os.homedir() : envHome.startsWith('~/') ? path.join(os.homedir(), envHome.slice(2)) : envHome;
    return expanded.endsWith('.agxp') ? expanded : path.join(expanded, '.agxp');
  }
  return path.join(os.homedir(), '.agxp');
}

// Set once at module load so all CLI child processes inherit it.
process.env.AGXP_HOME = resolveAgxpHome();
if (!process.env.AGXP_HOST) {
  process.env.AGXP_HOST = `claude-code/${SKILL_VER}`;
}
if (!process.env.AGXP_CHANNEL) {
  process.env.AGXP_CHANNEL = 'claude-code';
}

export const CONFIG = {
  TIMELINE_POLL_INTERVAL_SEC: parseInterval('AGXP_TIMELINE_POLL_INTERVAL', 300),
  AGXP_BIN: process.env.AGXP_BIN || 'agxp',
  AGXP_SERVER: process.env.AGXP_SERVER || 'agxp',
  SKILL_VER,
} as const;
