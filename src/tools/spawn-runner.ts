import { spawn, type ChildProcess } from 'node:child_process';
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
/**
 * Spawn a command WITHOUT waiting (ticket 06 background jobs): pipes stay
 * open for the job registry to capture, and on POSIX the child becomes a
 * process-group leader so killProcessTree can take the whole tree down.
 */
export function spawnBackground(
  invocation: SpawnInvocation,
  options: { cwd: string },
): ChildProcess {
  return spawn(invocation.file, invocation.args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

/**
 * Terminate a process and its children: taskkill /T /F on win32, the
 * negative pid (process group) on POSIX, plain pid as the group fallback.
 * Test seams: platform / spawnFn / killFn are injectable.
 */
export function killProcessTree(
  pid: number,
  deps: {
    platform?: NodeJS.Platform;
    spawnFn?: (file: string, args: string[]) => unknown;
    killFn?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const spawnFn = deps.spawnFn ?? ((file: string, args: string[]) => spawn(file, args, { windowsHide: true, stdio: 'ignore' }));
    try {
      spawnFn('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // taskkill unavailable: nothing safer to try from here
    }
    return;
  }
  const killFn = deps.killFn ?? ((target: number, signal: NodeJS.Signals) => { process.kill(target, signal); });
  try {
    killFn(-pid, 'SIGKILL');
  } catch {
    try {
      killFn(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
