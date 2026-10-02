/**
 * Named persistent shell sessions (batch-B ticket 07): one long-lived bash
 * process per name, commands fed over stdin and framed by a sentinel line
 * carrying `$?` (spike-proven under Git Bash pipes — see
 * .scratch/batch-b/shell-spike.mjs). State (cwd/env/functions) persists
 * across tool calls; an idle timeout recycles shells; an unexpected exit
 * rebuilds on the next call and marks the result. Commands MUST NOT read
 * stdin — a reading command would swallow the sentinel wire.
 */

/** The child-process surface the session needs (injectable for tests). */
export interface ShellProc {
  pid?: number;
  stdin: {
    write(chunk: string): boolean;
    end(): void;
    on(event: string, listener: (err: Error) => void): unknown;
  };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ShellSpawnOptions {
  cwd: string;
}

export type ShellSpawn = (options: ShellSpawnOptions) => ShellProc;

/** Result of one session command. */
export interface SessionRunResult {
  out: string;
  exitCode: number;
  /** True when this call rebuilt a shell that died unexpectedly. */
  restarted: boolean;
}

export interface ShellSessionRegistryOptions {
  spawn: ShellSpawn;
  /** Idle recycle window. Default 10 minutes. */
  idleMs?: number;
  /** Per-command timeout default. Mirrors the bash tool's 60s. */
  defaultTimeoutMs?: number;
}

interface QueueItem {
  command: string;
  timeoutMs: number;
  resolve: (result: SessionRunResult) => void;
}

interface ActiveRun {
  sentinel: string;
  resolve: (result: SessionRunResult) => void;
  timer: ReturnType<typeof setTimeout>;
  restarted: boolean;
}

const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

class ShellSession {
  private readonly idleMs: number;
  private readonly defaultTimeoutMs: number;
  private proc: ShellProc | null = null;
  private buffer = '';
  private active: ActiveRun | null = null;
  private readonly queue: QueueItem[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  /** The next spawned shell owes the caller a restarted marker. */
  private markerPending = false;
  /** True while WE close the shell on purpose (idle/reset/timeout). */
  private expectedClose = false;

  constructor(
    private readonly spawn: ShellSpawn,
    private readonly cwd: string,
    options: { idleMs?: number; defaultTimeoutMs?: number } = {},
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  run(command: string, timeoutMs?: number): Promise<SessionRunResult> {
    return new Promise<SessionRunResult>((resolve) => {
      this.queue.push({
        command,
        timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
        resolve,
      });
      this.pump();
    });
  }

  /** Explicitly drop the shell (bash session_reset); not a crash. */
  reset(): void {
    this.closeProc();
  }

  dispose(): void {
    this.closeProc();
    this.queue.length = 0;
    if (this.active !== null) {
      clearTimeout(this.active.timer);
      const orphan = this.active;
      this.active = null;
      orphan.resolve({
        out: '[session closed before the command completed]',
        exitCode: -1,
        restarted: orphan.restarted,
      });
    }
  }

  private pump(): void {
    if (this.active !== null) return;
    this.clearIdleTimer();
    if (this.proc !== null && this.queue.length === 0) {
      this.scheduleIdleTimer();
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) return;
    if (this.proc === null) this.spawnProc();
    const proc = this.proc;
    if (proc === null) {
      // Spawn failed (e.g. missing bash): report and stay unspawned.
      next.resolve({ out: '[session shell could not be started]', exitCode: -1, restarted: false });
      this.scheduleNextPump();
      return;
    }
    const sentinel = `__NOVA_S_${++this.seq}_${Date.now()}__RC=`;
    const wire = `${next.command}\nprintf '\\n%s\\n' "${sentinel}$?"\n`;
    const restarted = this.markerPending;
    this.markerPending = false;
    this.active = {
      sentinel,
      resolve: next.resolve,
      restarted,
      timer: setTimeout(() => this.onTimeout(next.timeoutMs), next.timeoutMs),
    };
    proc.stdin.write(wire);
  }

  private spawnProc(): void {
    let proc: ShellProc;
    try {
      proc = this.spawn({ cwd: this.cwd });
    } catch {
      this.proc = null;
      return;
    }
    proc.stdin.on('error', () => {
      // EPIPE when the shell dies mid-write; the close handler does the rest.
    });
    proc.stdout?.on('data', (chunk: Buffer | string) => this.consume(chunk));
    proc.stderr?.on('data', (chunk: Buffer | string) => this.consume(chunk));
    proc.on('close', () => this.onClose());
    proc.on('error', () => {
      // Reported via close afterwards; nothing to add here.
    });
    this.buffer = '';
    this.proc = proc;
  }

  private consume(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    const active = this.active;
    if (active === null) return;
    const idx = this.buffer.indexOf(active.sentinel);
    if (idx === -1) return;
    const tail = this.buffer.slice(idx + active.sentinel.length);
    const rcMatch = tail.match(/^\s*(-?\d+)/);
    const exitCode = rcMatch !== null ? Number(rcMatch[1]) : -1;
    const out = this.buffer.slice(0, idx);
    this.buffer = rcMatch !== null ? tail.slice(rcMatch[0].length) : tail;
    clearTimeout(active.timer);
    this.active = null;
    active.resolve({ out, exitCode, restarted: active.restarted });
    this.scheduleNextPump();
  }

  private onTimeout(timeoutMs: number): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    this.closeProc();
    active.resolve({
      out: `[session command timed out after ${timeoutMs}ms — the shell was restarted for the next call]`,
      exitCode: -1,
      restarted: active.restarted,
    });
    this.scheduleNextPump();
  }

  private onClose(): void {
    const wasExpected = this.expectedClose;
    this.expectedClose = false;
    this.proc = null;
    const active = this.active;
    if (active !== null) {
      this.active = null;
      clearTimeout(active.timer);
      active.resolve({
        out: `${this.buffer}\n[session died mid-command — the next call will start a fresh shell]`,
        exitCode: -1,
        restarted: active.restarted,
      });
    }
    if (!wasExpected) {
      // Crash / `exit` inside a command: the NEXT shell owes a marker.
      this.markerPending = true;
    }
    this.buffer = '';
    this.scheduleNextPump();
  }

  private scheduleNextPump(): void {
    // Drain the queue after the current resolve() returns, but on a
    // microtask: a macrotask would strand pending commands under fake
    // timers and test awaits.
    queueMicrotask(() => this.pump());
  }

  private closeProc(): void {
    const proc = this.proc;
    if (proc === null) return;
    this.expectedClose = true;
    this.clearIdleTimer();
    try {
      proc.kill();
    } catch {
      // already gone
    }
    this.proc = null;
  }

  private clearIdleTimer(): boolean {
    if (this.idleTimer === null) return false;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return true;
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    if (this.proc === null || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.closeProc();
    }, this.idleMs);
  }
}

export class ShellSessionRegistry {
  private readonly sessions = new Map<string, ShellSession>();
  private readonly idleMs: number | undefined;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(private readonly options: ShellSessionRegistryOptions) {
    this.idleMs = options.idleMs;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  /** Run one command on the named session (spawned with this cwd). */
  run(name: string, command: string, cwd: string, timeoutMs?: number): Promise<SessionRunResult> {
    let session = this.sessions.get(name);
    if (session === undefined) {
      session = new ShellSession(this.options.spawn, cwd, {
        idleMs: this.idleMs,
        defaultTimeoutMs: this.defaultTimeoutMs,
      });
      this.sessions.set(name, session);
    }
    return session.run(command, timeoutMs);
  }

  reset(name: string): void {
    const session = this.sessions.get(name);
    if (session !== undefined) {
      session.reset();
      this.sessions.delete(name);
    }
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
