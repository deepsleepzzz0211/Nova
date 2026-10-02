import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { JobRegistry, type JobHandle } from '../../src/tools/jobs.js';
import { createJobOutputTool, createJobKillTool } from '../../src/tools/jobs.js';
import { createBashTool } from '../../src/tools/bash.js';
import type { ShellPlan } from '../../src/tools/shell-routing.js';

// Batch-B ticket 06 (G14a): background job primitives. bash gains
// background:true (spawn, return {jobId,pid} immediately); job_output reads
// incrementally by cursor; job_kill terminates the process tree. The table
// is in-process, capped, and kills are idempotent.

const plan: ShellPlan = {
  kind: 'bash',
  path: 'C:/Program Files/Git/bin/bash.exe',
  transport: 'argv',
  label: 'Git Bash',
};

class FakeHandle extends EventEmitter implements JobHandle {
  pid = 4321;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** Start helper: refuses are test failures, success narrows to the id. */
function startJob(jobs: JobRegistry, command: string, handle: FakeHandle): string {
  const r = jobs.start(command, handle);
  if (!r.started) throw new Error('unexpected refusal: ' + r.reason);
  return r.jobId;
}

function makeCtx(tmpDir: string): { workingDirectory: string; abortSignal: AbortSignal } {
  return { workingDirectory: tmpDir, abortSignal: new AbortController().signal };
}

function makeHandle(pid: number): FakeHandle {  const h = new FakeHandle();
  h.pid = pid;
  return h;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-jobs-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('JobRegistry', () => {
  it('captures stdout+stderr and serves incremental reads by cursor', () => {
    const jobs = new JobRegistry({ logDir: tmp });
    const h = makeHandle(1);
    const jobId = startJob(jobs, 'echo hi', h);
    (h.stdout as EventEmitter).emit('data', Buffer.from('abc'));
    (h.stderr as EventEmitter).emit('data', Buffer.from('def'));

    const first = jobs.read(jobId, 0);
    expect(first.found).toBe(true);
    expect(first.text).toBe('abcdef');
    expect(first.running).toBe(true);

    const again = jobs.read(jobId, first.nextCursor!);
    expect(again.text).toBe('');

    (h.stdout as EventEmitter).emit('data', Buffer.from('ghi'));
    const second = jobs.read(jobId, first.nextCursor!);
    expect(second.text).toBe('ghi');
    expect(second.nextCursor).toBe(9);
  });

  it('records the exit code on close and flips running off', () => {
    const jobs = new JobRegistry({ logDir: tmp });
    const h = makeHandle(2);
    const jobId = startJob(jobs, 't', h);
    h.emit('close', 7);
    const r = jobs.read(jobId, 0);
    expect(r.running).toBe(false);
    expect(r.exitCode).toBe(7);
  });

  it('null exit codes (signal death) surface as -1', () => {
    const jobs = new JobRegistry({ logDir: tmp });
    const h = makeHandle(3);
    const jobId = startJob(jobs, 't', h);
    h.emit('close', null);
    expect(jobs.read(jobId, 0).exitCode).toBe(-1);
  });

  it('ring limit drops the oldest prefix but keeps absolute cursors', () => {
    const jobs = new JobRegistry({ logDir: tmp, bufferLimit: 10 });
    const h = makeHandle(4);
    const jobId = startJob(jobs, 't', h);
    (h.stdout as EventEmitter).emit('data', Buffer.from('0123456789ABCD'));
    const r = jobs.read(jobId, 0);
    expect(r.truncatedPrefix).toBe(true);
    expect(r.text).toBe('0123456789ABCD'.slice(4));
    expect(r.nextCursor).toBe(14);
    // The temp file keeps the FULL output (the ring only bounds memory reads)
    expect(fs.readFileSync(path.join(tmp, `${jobId}.log`), 'utf-8')).toBe('0123456789ABCD');
  });

  it('refuses to start past the running cap and explains', () => {
    const jobs = new JobRegistry({ logDir: tmp, maxRunning: 2 });
    expect(jobs.start('a', makeHandle(5)).started).toBe(true);
    expect(jobs.start('b', makeHandle(6)).started).toBe(true);
    const third = jobs.start('c', makeHandle(7));
    expect(third.started).toBe(false);
    if (third.started !== true) expect(third.reason).toMatch(/limit/i);
  });

  it('finished jobs free the running slot but stay readable', () => {
    const jobs = new JobRegistry({ logDir: tmp, maxRunning: 1 });
    const h = makeHandle(8);
    const jobId = startJob(jobs, 'a', h);
    h.emit('close', 0);
    expect(jobs.start('b', makeHandle(9)).started).toBe(true);
    expect(jobs.read(jobId, 0).found).toBe(true);
  });

  it('kill terminates via the injected tree-killer and is idempotent', () => {
    const terminate = vi.fn();
    const jobs = new JobRegistry({ logDir: tmp, terminate });
    const h = makeHandle(10);
    const jobId = startJob(jobs, 'a', h);
    expect(jobs.kill(jobId)).toBe('killed');
    expect(terminate).toHaveBeenCalledWith(h);
    expect(jobs.kill(jobId)).toBe('kill-requested');
    h.emit('close', null);
    expect(jobs.kill(jobId)).toBe('exited');
  });

  it('unknown ids are reported for read and kill', () => {
    const jobs = new JobRegistry({ logDir: tmp });
    expect(jobs.read('job-999', 0).found).toBe(false);
    expect(jobs.kill('job-999')).toBe('unknown');
  });
});

describe('job tools surface', () => {
  it('job_output reads by cursor and errors on unknown id', async () => {
    const jobs = new JobRegistry({ logDir: tmp });
    const h = makeHandle(11);
    const jobId = startJob(jobs, 'a', h);
    (h.stdout as EventEmitter).emit('data', Buffer.from('line one\n'));
    const tool = createJobOutputTool(jobs);
    const ok = await tool.execute({ jobId }, makeCtx(tmp));
    expect(ok.content).toContain('line one');
    expect(ok.isError).toBeUndefined();
    const bad = await tool.execute({ jobId: 'job-404' }, makeCtx(tmp));
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/unknown job/i);
  });

  it('job_kill is ask-level and reports exited/unknown distinctly', async () => {
    const jobs = new JobRegistry({ logDir: tmp, terminate: () => {} });
    const h = makeHandle(12);
    const jobId = startJob(jobs, 'a', h);
    const tool = createJobKillTool(jobs);
    expect(tool.permission?.mode).toBe('ask');
    const first = await tool.execute({ jobId }, makeCtx(tmp));
    expect(first.content).toMatch(/termination requested/i);
    h.emit('close', 3);
    const second = await tool.execute({ jobId }, makeCtx(tmp));
    expect(second.content).toMatch(/already exited/i);
    const bad = await tool.execute({ jobId: 'job-404' }, makeCtx(tmp));
    expect(bad.isError).toBe(true);
  });

  it('bash background:true spawns through the registry without waiting', async () => {
    const jobs = new JobRegistry({ logDir: tmp });
    const spawnBackground = vi.fn(() => makeHandle(13));
    const tool = createBashTool({ resolvePlan: () => plan, jobs, spawnBackground });
    const result = await tool.execute(
      { command: 'sleep 100', background: true },
      { workingDirectory: tmp, abortSignal: new AbortController().signal },
    );
    expect(spawnBackground).toHaveBeenCalledTimes(1);
    expect(result.content).toMatch(/job-\d+ \(pid 13\)/);
    expect(result.content).toMatch(/job_output/);
  });

  it('bash background respects the cap and reports a refusal', async () => {
    const jobs = new JobRegistry({ logDir: tmp, maxRunning: 0 });
    const tool = createBashTool({ resolvePlan: () => plan, jobs, spawnBackground: vi.fn(() => makeHandle(14)) });
    const result = await tool.execute(
      { command: 'true', background: true },
      { workingDirectory: tmp, abortSignal: new AbortController().signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/limit/i);
  });

  it('foreground bash keeps working when background jobs are not wired', async () => {
    const tool = createBashTool({ resolvePlan: () => plan });
    const result = await tool.execute(
      { command: 'echo x', background: true },
      { workingDirectory: tmp, abortSignal: new AbortController().signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not available/i);
  });
});
