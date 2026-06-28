/**
 * Generic helper to run `agxp` CLI commands as one-shot subprocesses.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execFile } from 'child_process';
import { agxpChildEnv } from './config.js';

const log = console.error;

const EXIT_AUTH_REQUIRED = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export type CliResult<T> =
  | { kind: 'success'; data: T }
  | { kind: 'session_required'; stderr: string }
  | { kind: 'error'; error: Error; exitCode: number | null; stderr: string };

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
}

export function execAgxp<T>(
  bin: string,
  args: string[],
  options?: ExecOptions
): Promise<CliResult<T>> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    log(`[agxp:cli] exec: ${bin} ${args.join(' ')}`);

    execFile(
      bin,
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        env: agxpChildEnv(),
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          const numericExit =
            typeof exitCode === 'number'
              ? exitCode
              : error.killed
                ? null
                : (error as any).status ?? null;

          if (numericExit === EXIT_AUTH_REQUIRED) {
            log(`[agxp:cli] session required: ${stderr.trim()}`);
            resolve({ kind: 'session_required', stderr: stderr.trim() });
            return;
          }

          log(`[agxp:cli] failed (exit=${numericExit}): ${stderr.trim() || error.message}`);
          resolve({
            kind: 'error',
            error: new Error(stderr.trim() || error.message),
            exitCode: numericExit,
            stderr: stderr.trim(),
          });
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve({
            kind: 'success',
            data: undefined as unknown as T,
          });
          return;
        }

        try {
          const data = JSON.parse(trimmed) as T;
          resolve({ kind: 'success', data });
        } catch (parseError) {
          log(`[agxp:cli] JSON parse error: ${(parseError as Error).message}`);
          resolve({
            kind: 'error',
            error: new Error(`Failed to parse CLI output: ${(parseError as Error).message}`),
            exitCode: 0,
            stderr: '',
          });
        }
      }
    );
  });
}
