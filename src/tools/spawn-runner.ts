import { spawn } from 'node:child_process';
import type { SpawnInvocation } from './shell-routing.js';

/**
 * Shared spawn-and-collect runner for command tools (bash, powershell).
 * One place owns the timeout ladder (SIGTERM, then SIGKILL after 5s), the
 * stdout+stderr merge, and the error-as-result contract — the tools only
 * differ in how they build the invocation.
 */
export interface RunResult {
  content: string;
  exitCode: number;
  isError?: boolean;
}

export function runSpawnCommand(
  invocation: SpawnInvocation,
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<RunResult> {
  const { cwd, signal, timeoutMs } = options;
  return new Promise<RunResult>((resolve) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      signal,
      stdio: [invocation.stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    if (invocation.stdinText !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE when the shell exits early */ });
      child.stdin.end(invocation.stdinText);
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.on('close', () => { clearTimeout(killTimer); });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        content: [stdout, stderr].filter(Boolean).join(''),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ content: err.message, exitCode: 1, isError: true });
    });
  });
}
