import { spawn, type ChildProcess } from 'node:child_process';
import type { SpawnInvocation } from './shell-routing.js';
import { runSpawnCommand, spawnBackground, type RunResult } from './spawn-runner.js';
import type { JobHandle } from './jobs.js';

/**
 * ShellLauncher (arch ticket 02; arch2 ticket A1): the ONE seam through
 * which every shell child process is spawned — foreground run, background
 * start, hook capture, interactive session. The seam takes the SANDBOX
 * itself, not a bare wrap function: applying the tier-2 wrap, draining the
 * degrade notices it produces, and reporting them is launcher-owned, so no
 * composition root can get the ordering wrong or forget a drain. A caller
 * that must run OUTSIDE the sandbox (declarative hooks — user-supplied
 * commands, the Claude-Code-parity documented boundary) injects the
 * `unsandboxed` adapter explicitly; the choice stays visible at the
 * construction site instead of being an absent optional.
 */

/** Minimal view of the OS sandbox the launcher drives (OsSandbox satisfies it). */
export interface SandboxView {
  wrapSpawn(invocation: SpawnInvocation, cwd: string): SpawnInvocation;
  /** Notices accumulated since the last drain, in order; each surfaces once. */
  drainNotices(): string[];
}

/** The explicit no-sandbox adapter: identity wrap, no notices, ever. */
export const unsandboxed: SandboxView = {
  wrapSpawn: (invocation) => invocation,
  drainNotices: () => [],
};

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

export interface ShellLauncherDeps {
  sandbox: SandboxView;
  /** Notice report channel; defaults to stderr with the [sandbox] prefix. */
  onNotice?: (notice: string) => void;
}

const defaultOnNotice = (notice: string): void => {
  console.error(`[sandbox] ${notice}`);
};

export function createShellLauncher(deps: ShellLauncherDeps): ShellLauncher {
  const report = deps.onNotice ?? defaultOnNotice;
  // Wrap, then drain: degrade notices produced by a wrap surface on first
  // use of each shell, exactly once (the sandbox's drain empties them).
  const apply = (invocation: SpawnInvocation, cwd: string): SpawnInvocation => {
    const wrapped = deps.sandbox.wrapSpawn(invocation, cwd);
    for (const notice of deps.sandbox.drainNotices()) report(notice);
    return wrapped;
  };
  // Startup visibility: the grants-active / fallback notice exists BEFORE
  // any spawn and must not wait for the first tool call.
  for (const notice of deps.sandbox.drainNotices()) report(notice);

  return {
    run(invocation, options) {
      return runSpawnCommand(apply(invocation, options.cwd), options);
    },

    start(invocation, options) {
      return spawnBackground(apply(invocation, options.cwd), options);
    },

    capture(invocation, options) {
      const inv = apply(invocation, options.cwd);
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
      const inv = apply(invocation, options.cwd);
      return spawn(inv.file, inv.args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
  };
}
