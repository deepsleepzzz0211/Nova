import { spawn, type ChildProcess } from 'node:child_process';
import type { SpawnInvocation } from './shell-routing.js';
import { runSpawnCommand, spawnBackground, type RunResult } from './spawn-runner.js';
import type { JobHandle } from './jobs.js';

/**
 * ShellLauncher (arch ticket 02): the ONE seam through which every shell
 * child process is spawned — foreground run, background start, hook
 * capture, interactive session. The OS-level wrap (tier-2) is applied
 * inside, unconditionally: a tool CANNOT reach spawn without passing it,
 * so "every shell child is wrapped" is structural, not a per-caller
 * convention. Callers that must run outside the sandbox (declarative
 * hooks — user-supplied commands, the Claude-Code-parity documented
 * boundary) inject identityWrap explicitly; that choice is then visible
 * at the construction site instead of being an absent optional.
 */

export type WrapSpawn = (invocation: SpawnInvocation, cwd: string) => SpawnInvocation;

export const identityWrap: WrapSpawn = (invocation) => invocation;

export interface LauncherRunOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CapturedResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellLauncher {
  /** Merged-output foreground run with the SIGTERM->SIGKILL ladder. */
  run(invocation: SpawnInvocation, options: LauncherRunOptions): Promise<RunResult>;
  /** Fire-and-return background spawn (pipes stay open for the job registry). */
  start(invocation: SpawnInvocation, options: { cwd: string }): JobHandle;
  /** Separate-stream capture with the invocation's stdin feed (hook contract shape). */
  capture(invocation: SpawnInvocation, options: { cwd: string; timeoutMs: number }): Promise<CapturedResult>;
  /** Long-lived interactive child with piped stdio (persistent sessions). */
  interactive(invocation: SpawnInvocation, options: { cwd: string }): ChildProcess;
}

export function createShellLauncher(deps: { wrap: WrapSpawn }): ShellLauncher {
  return {
    run(invocation, options) {
      return runSpawnCommand(deps.wrap(invocation, options.cwd), options);
    },

    start(invocation, options) {
      return spawnBackground(deps.wrap(invocation, options.cwd), options);
    },

    capture(invocation, options) {
      const inv = deps.wrap(invocation, options.cwd);
      return new Promise<CapturedResult>((resolve) => {
        const child = spawn(inv.file, inv.args, {
          cwd: options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (d: string) => {
          stdout += d;
        });
        child.stderr.on('data', (d: string) => {
          stderr += d;
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: 127, stdout: '', stderr: String(err), timedOut: false });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => {
          /* EPIPE when the child exits before reading */
        });
        child.stdin.end(inv.stdinText ?? '');
      });
    },

    interactive(invocation, options) {
      const inv = deps.wrap(invocation, options.cwd);
      return spawn(inv.file, inv.args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
  };
}
