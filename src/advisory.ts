/**
 * Best-effort reader for the on-disk version-advisory record written by the
 * agxp CLI after every invocation: <AGXP_HOME>/advisory.json
 *   { client?: string; skills?: string; plugin?: string; at?: string }
 *
 * The CLI is the only writer; the plugin shell (this channel) is a reader on
 * the poll loop. The advisory is purely advisory — this module NEVER throws:
 * an absent, unreadable, or corrupt file yields {plugin:''} so the channel's
 * periodic check degrades to "no nudge" instead of crashing.
 *
 * Path resolution reuses config.ts:resolveAgxpHome(), the SAME precedence the
 * CLI itself uses (honor AGXP_HOME with ~ expansion, append `.agxp` unless the
 * value already ends in it, default ~/.agxp), so the plugin and the CLI child
 * processes it spawns always agree on one workspace.
 */
import { readFile } from 'fs/promises';
import * as path from 'path';

import { resolveAgxpHome } from './config.js';

export interface AdvisoryFile {
  client?: string;
  skills?: string;
  plugin?: string;
  at?: string;
}

export function advisoryFilePath(): string {
  return path.join(resolveAgxpHome(), 'advisory.json');
}

const EMPTY: AdvisoryFile = { plugin: '' };

/**
 * Read & parse <HomeDir>/advisory.json. Never throws:
 *  - absent / unreadable  → {plugin:''}
 *  - corrupt / non-object → {plugin:''}
 * Errors are logged to stderr (best-effort) so a permissions or parse problem
 * is observable without surfacing as a crash.
 */
export async function readAdvisory(): Promise<AdvisoryFile> {
  let data: string;
  try {
    data = await readFile(advisoryFilePath(), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT is the common "fresh host, never written" case — not worth a log line.
    if (code !== 'ENOENT') {
      console.error(`[agxp] advisory read failed (${code ?? 'unknown'}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ...EMPTY };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    console.error(`[agxp] advisory parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...EMPTY };
  }
  // Only trust an object body; arrays/null/primitives → empty.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('[agxp] advisory parse failed: not a JSON object');
    return { ...EMPTY };
  }
  return parsed as AdvisoryFile;
}
