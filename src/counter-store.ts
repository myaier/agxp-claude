/**
 * Durable, monotonic, best-effort counter store for shell telemetry.
 *
 * The shell increments named counters here; `agxp shell report` reads the file
 * and POSTs the cumulative values to the server. Counters only ever grow (the
 * server computes deltas across reports). `epoch` identifies the file's
 * lifecycle: it stays fixed across increments and is regenerated only when the
 * file is missing or corrupt (i.e. a reset), so the server can tell a reset
 * apart from normal growth.
 *
 * Best-effort: increments NEVER throw — telemetry must not crash the shell. A
 * failed read/write is logged to stderr and skipped. Writes are atomic
 * (temp + rename) to avoid torn files. The shell process is the sole writer;
 * concurrent same-shell processes (e.g. multiple Claude MCP servers) may lose
 * an increment under a write race — acceptable for coarse health telemetry.
 *
 * File shape: {"epoch":"<string>","counters":{"<name>":<int>,...}} at
 * <AGXP_HOME>/instances/<server>/counters.json (shared contract with the CLI
 * reader in internal/counters).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAgxpHome } from './config.js';

const log = console.error;

interface StoreFile {
  epoch: string;
  counters: Record<string, number>;
}

export class CounterStore {
  private readonly path: string;

  constructor(serverName: string, homeDir: string = resolveAgxpHome()) {
    this.path = join(homeDir, 'instances', serverName, 'counters.json');
  }

  private load(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (
        parsed && typeof parsed.epoch === 'string' &&
        parsed.counters && typeof parsed.counters === 'object'
      ) {
        return { epoch: parsed.epoch, counters: parsed.counters as Record<string, number> };
      }
    } catch {
      // missing or corrupt → fall through to a fresh store (new epoch = reset)
    }
    return { epoch: String(Date.now()), counters: {} };
  }

  private save(store: StoreFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Increment a counter by `by` (default 1). Never throws. by <= 0 is a no-op. */
  incr(name: string, by = 1): void {
    if (by <= 0) return;
    try {
      const store = this.load();
      store.counters[name] = (store.counters[name] ?? 0) + by;
      this.save(store);
    } catch (err) {
      log(`[agxp] counter incr failed (${name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
