import * as fs from 'fs';
import * as path from 'path';
import type { SpawnInvocation } from './shell-routing.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * Background job primitives (batch-B ticket 06): the bash tool can spawn a
 * command without waiting, and the job_output / job_kill tools read its
 * incremental output by cursor or terminate its process tree. The table is
 * in-process (per session) — a crash loses it by design; the full output
 * additionally goes to a log file so the bounded in-memory ring can drop
 * old prefixes without hiding data.
 */

/** The ChildProcess surface the registry needs (injectable for tests). */
export interface JobHandle {
  /** ChildProcess.pid is undefined when the spawn failed early. */
  pid?: number;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}

/** One job row. */
interface JobRecord {
  id: string;
  command: string;
  handle: JobHandle;
  /** Retained tail of the output (bounded by bufferLimit). */
  log: string;
  /** Characters dropped from the head of the retained log. */
  headDiscarded: number;
  /** Absolute total output length so far = next cursor. */
  total: number;
  running: boolean;
  exitCode: number | undefined;
  killRequested: boolean;
  logPath: string;
}

export interface JobRegistryOptions {
  /** Where <jobId>.log full-output files are written. */
  logDir: string;
  /** Max concurrently RUNNING jobs. Default 10. */
  maxRunning?: number;
  /** In-memory retained tail per job. Default 64 KiB of characters. */
  bufferLimit?: number;
  /** Process-tree termination (injected: taskkill / killpg at the edge). */
  terminate?: (handle: JobHandle) => void;
}

/** Result of a registry start: either a job row or a refusal. */
export type JobStartResult =
  | { started: true; jobId: string; /** undefined only when the child died before reporting a pid */ pid?: number }
  | { started: false; reason: string };

/** Result of a registry read. */
export interface JobReadResult {
  found: boolean;
  text?: string;
  nextCursor?: number;
  running?: boolean;
  exitCode?: number;
  truncatedPrefix?: boolean;
}

/** Result of a registry kill. */
export type JobKillOutcome = 'killed' | 'kill-requested' | 'exited' | 'unknown';

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly logDir: string;
  private readonly maxRunning: number;
  private readonly bufferLimit: number;
  private readonly terminate: (handle: JobHandle) => void;
  private seq = 0;

  constructor(options: JobRegistryOptions) {
    this.logDir = options.logDir;
    this.maxRunning = options.maxRunning ?? 10;
    this.bufferLimit = options.bufferLimit ?? 65_536;
    this.terminate = options.terminate ?? ((handle) => { handle.kill('SIGTERM'); });
  }

  /**
   * Cap decision WITHOUT consuming a slot: callers that must not spawn
   * before refusing (bash background:true) gate on this. Synchronous
   * sequence (check -> start, no await gap) makes the check race-free.
   */
  capacityRefusal(): string | undefined {
    let running = 0;
    for (const job of this.jobs.values()) if (job.running) running++;
    if (running >= this.maxRunning) {
      return (
        `Background job limit reached (${running}/${this.maxRunning} running). ` +
        'Wait for a job to finish (' + JOB_OUTPUT_TOOL_NAME + ' shows its exit code) or terminate one with ' + JOB_KILL_TOOL_NAME + ' first.'
      );
    }
    return undefined;
  }

  /** Register a spawned handle; refuses past the running cap. */
  start(command: string, handle: JobHandle): JobStartResult {
    const refusal = this.capacityRefusal();
    if (refusal !== undefined) {
      return { started: false, reason: refusal };
    }
    const id = `job-${++this.seq}`;
    const record: JobRecord = {
      id,
      command,
      handle,
      log: '',
      headDiscarded: 0,
      total: 0,
      running: true,
      exitCode: undefined,
      killRequested: false,
      logPath: path.join(this.logDir, `${id}.log`),
    };
    this.jobs.set(id, record);
    handle.stdout?.on('data', (chunk: Buffer) => this.append(record, chunk.toString()));
    handle.stderr?.on('data', (chunk: Buffer) => this.append(record, chunk.toString()));
    handle.on('close', (code: number | null) => {
      record.running = false;
      record.exitCode = code ?? -1;
    });
    handle.on('error', (err: Error) => {
      this.append(record, `${err.message}\n`);
      record.running = false;
      if (record.exitCode === undefined) record.exitCode = -1;
    });
    return { started: true, jobId: id, pid: handle.pid };
  }

  /**
   * The full background-start sequence in one call (arch ticket 03):
   * refuse-before-spawn, spawn via the injected launcher seam (which owns
   * the OS wrap), register, and kill the handle if a race refused anyway.
   * Callers cannot get this order wrong because there is no order left to
   * know.
   */
  startFrom(
    command: string,
    invocation: SpawnInvocation,
    opts: { cwd: string; spawn: (invocation: SpawnInvocation, options: { cwd: string }) => JobHandle },
  ): JobStartResult {
    const refusal = this.capacityRefusal();
    if (refusal !== undefined) {
      return { started: false, reason: refusal };
    }
    let handle: JobHandle;
    try {
      handle = opts.spawn(invocation, { cwd: opts.cwd });
    } catch (err) {
      return {
        started: false,
        reason: `Background spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const started = this.start(command, handle);
    if (!started.started) {
      try {
        handle.kill('SIGTERM');
      } catch {
        // Already dead; nothing to orphan.
      }
      return started;
    }
    return started;
  }

  /** Incremental read from an absolute cursor. */
  read(jobId: string, cursor: number): JobReadResult {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { found: false };
    const from = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    const start = Math.max(from, job.headDiscarded);
    return {
      found: true,
      text: job.log.slice(start - job.headDiscarded),
      nextCursor: job.total,
      running: job.running,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      truncatedPrefix: from < job.headDiscarded,
    };
  }

  /** Idempotent tree-kill: killed once, reported thereafter. */
  kill(jobId: string): JobKillOutcome {
    const job = this.jobs.get(jobId);
    if (job === undefined) return 'unknown';
    if (!job.running) return 'exited';
    if (job.killRequested) return 'kill-requested';
    job.killRequested = true;
    this.terminate(job.handle);
    return 'killed';
  }

  private append(job: JobRecord, text: string): void {
    if (text.length === 0) return;
    job.log += text;
    job.total += text.length;
    try {
      fs.appendFileSync(job.logPath, text);
    } catch {
      // The log file is best-effort; the in-memory ring still serves reads.
    }
    const excess = job.log.length - this.bufferLimit;
    if (excess > 0) {
      job.log = job.log.slice(excess);
      job.headDiscarded += excess;
    }
  }
}

/** Job tool names — the single source referenced by the tools and by bash. */
export const JOB_OUTPUT_TOOL_NAME = 'job_output';
export const JOB_KILL_TOOL_NAME = 'job_kill';

/** job_output — incremental output of a background job (read-only, auto). */
export function createJobOutputTool(registry: JobRegistry): Tool {
  return {
    name: JOB_OUTPUT_TOOL_NAME,
    description:
      'Read the output of a background job started with bash background:true. ' +
      'Pass the cursor from the previous response to read only new output. ' +
      'Reports the exit code once the job has finished.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id returned by the background bash call' },
        cursor: { type: 'number', description: 'Absolute output offset to read from (default 0)' },
      },
      required: ['jobId'],
    },
    fileAccess: 'read',
    permission: { mode: 'auto' },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      void context;
      const jobId = typeof params.jobId === 'string' ? params.jobId : '';
      const cursor = typeof params.cursor === 'number' ? params.cursor : 0;
      const result = registry.read(jobId, cursor);
      if (!result.found) {
        return { content: `Unknown job "${jobId}". Start one with bash background:true.`, isError: true };
      }
      const head = result.text === '' ? '(no new output)' : result.text;
      const status = result.running
        ? 'running'
        : `exited with code ${result.exitCode}`;
      const truncation = result.truncatedPrefix
        ? '\n[older output rolled out of the in-memory buffer; full text in the job log file]'
        : '';
      return {
        content: `${head}\n\n[cursor ${result.nextCursor} · ${status}]${truncation}`,
      };
    },
  };
}

/** job_kill — terminate a background job's process tree (ask-level). */
export function createJobKillTool(registry: JobRegistry): Tool {
  return {
    name: JOB_KILL_TOOL_NAME,
    description: 'Terminate a background job and its child process tree.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id returned by the background bash call' },
      },
      required: ['jobId'],
    },
    permission: { mode: 'ask', message: 'Terminating a background job requires confirmation' },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      void context;
      const jobId = typeof params.jobId === 'string' ? params.jobId : '';
      const outcome = registry.kill(jobId);
      switch (outcome) {
        case 'unknown':
          return { content: `Unknown job "${jobId}".`, isError: true };
        case 'exited':
          return { content: `Job ${jobId} already exited — nothing to kill.` };
        case 'kill-requested':
          return { content: `Termination for ${jobId} was already requested; waiting for it to close.` };
        case 'killed':
          return { content: `Termination requested for ${jobId} (process tree). Read final output with ${JOB_OUTPUT_TOOL_NAME}.` };
      }
    },
  };
}
