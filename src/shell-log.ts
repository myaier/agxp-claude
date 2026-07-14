import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgxpHome } from './config.js';

export type ShellLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ShellLogRecordInput {
  level?: ShellLogLevel;
  server?: string;
  component: string;
  event: string;
  message: string;
  attrs?: Record<string, unknown>;
}

export interface ShellLogOptions {
  shell: 'claude' | 'codex' | 'openclaw';
  fileBase: string;
  homeDir?: string;
}

const LEVELS: Record<ShellLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export class ShellLog {
  private readonly shell: string;
  private readonly fileBase: string;
  private readonly homeDir: string;

  constructor(options: ShellLogOptions) {
    this.shell = options.shell;
    this.fileBase = options.fileBase;
    this.homeDir = options.homeDir ?? resolveAgxpHome();
  }

  debug(input: Omit<ShellLogRecordInput, 'level'>): void {
    this.write({ ...input, level: 'debug' });
  }

  info(input: Omit<ShellLogRecordInput, 'level'>): void {
    this.write({ ...input, level: 'info' });
  }

  warn(input: Omit<ShellLogRecordInput, 'level'>): void {
    this.write({ ...input, level: 'warn' });
  }

  error(input: Omit<ShellLogRecordInput, 'level'>): void {
    this.write({ ...input, level: 'error' });
  }

  write(input: ShellLogRecordInput): void {
    try {
      if ((process.env.AGXP_SHELL_LOG ?? 'on').toLowerCase() === 'off') return;
      const level = input.level ?? 'info';
      if (LEVELS[level] < LEVELS[this.minLevel()]) return;

      const path = this.currentPath();
      mkdirSync(join(this.homeDir, 'logs'), { recursive: true });
      this.rotateIfNeeded(path);

      const record = {
        ts: new Date().toISOString(),
        level,
        shell: this.shell,
        server: input.server ?? '',
        component: input.component,
        event: input.event,
        message: input.message,
        attrs: input.attrs ?? undefined,
      };
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Local diagnostics must never alter shell behavior.
    }
  }

  private currentPath(): string {
    return join(this.homeDir, 'logs', `${this.fileBase}.jsonl`);
  }

  private minLevel(): ShellLogLevel {
    const raw = (process.env.AGXP_SHELL_LOG_LEVEL ?? 'info').toLowerCase();
    return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
  }

  private maxBytes(): number {
    const n = parseInt(process.env.AGXP_SHELL_LOG_MAX_BYTES ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
  }

  private maxFiles(): number {
    const n = parseInt(process.env.AGXP_SHELL_LOG_MAX_FILES ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_FILES;
  }

  private rotateIfNeeded(path: string): void {
    if (!existsSync(path)) return;
    if (statSync(path).size < this.maxBytes()) return;

    const max = this.maxFiles();
    if (max <= 0) {
      rmSync(path, { force: true });
      return;
    }

    const dir = join(this.homeDir, 'logs');
    rmSync(join(dir, `${this.fileBase}.${max}.jsonl`), { force: true });
    for (let i = max - 1; i >= 1; i--) {
      const from = join(dir, `${this.fileBase}.${i}.jsonl`);
      const to = join(dir, `${this.fileBase}.${i + 1}.jsonl`);
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(path, join(dir, `${this.fileBase}.1.jsonl`));
  }
}
