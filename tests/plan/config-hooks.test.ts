import { describe, it, expect, vi } from 'vitest';
import {
  buildPipelineHooks,
  type HookRequest,
  type HookSpec,
  type SpawnHook,
  type SpawnedHook,
} from '../../src/hooks/config-hooks.js';

// Batch-B ticket 03: declarative hooks. config.toml [[hooks.pre_tool_use]] /
// [[hooks.post_tool_use]] entries become PipelineHooks that run a shell
// command per matching tool call: JSON input on stdin; pre denies via exit
// code 2 or a {"deny":true} stdout; post stdout becomes a note.

function spawner(result: Partial<SpawnedHook>, calls: HookRequest[]): SpawnHook {
  return async (req) => {
    calls.push(req);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
}

const pre: HookSpec = { event: 'pre_tool_use', matcher: 'write_file', command: 'check.sh' };
const post: HookSpec = { event: 'post_tool_use', matcher: '*', command: 'observe.sh' };

describe('buildPipelineHooks', () => {
  it('pre hook denies on exit code 2 with stderr as the reason', async () => {
    const calls: HookRequest[] = [];
    const hooks = buildPipelineHooks([{ ...pre }], spawner({ code: 2, stderr: 'no writes to src/gen' }, calls));
    const decision = await hooks.pre![0]!({ tool: 'write_file', params: { path: 'a' } });
    expect(decision).toEqual({ deny: true, reason: expect.stringContaining('no writes to src/gen') });
    const stdin = JSON.parse(calls[0]!.inputJson);
    expect(stdin).toMatchObject({ tool: 'write_file', params: { path: 'a' } });
  });

  it('pre hook denies via structured stdout JSON', async () => {
    const hooks = buildPipelineHooks(
      [{ ...pre }],
      spawner({ code: 0, stdout: JSON.stringify({ deny: true, reason: 'policy say no' }) }, []),
    );
    const decision = await hooks.pre![0]!({ tool: 'write_file', params: {} });
    expect(decision).toEqual({ deny: true, reason: 'policy say no' });
  });

  it('deny-JSON on stdout denies at ANY exit code (ticket 03 dual channel)', async () => {
    // A hook that prints the structured verdict but exits 1 (not 2) asked
    // to deny; the pass-through-on-nonzero path must not swallow it.
    const hooks = buildPipelineHooks(
      [{ ...pre }],
      spawner({ code: 1, stdout: JSON.stringify({ deny: true, reason: 'nope' }), stderr: 'noise' }, []),
    );
    const decision = await hooks.pre![0]!({ tool: 'write_file', params: {} });
    expect(decision?.deny).toBe(true);
    expect(decision?.reason).toContain('nope');
  });

  it('non-zero WITHOUT deny-JSON still passes through with a note', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hooks = buildPipelineHooks([{ ...pre }], spawner({ code: 1, stdout: 'just chatter', stderr: 'boom' }, []));
      const decision = await hooks.pre![0]!({ tool: 'write_file', params: {} });
      expect(decision?.deny).toBeUndefined();
      expect(decision?.note).toMatch(/failed \(exit 1\)/);
    } finally {
      warn.mockRestore();
    }
  });

  it('pre hook exit 0 passes; non-2 failures pass through but stay visible (stderr + note, ticket 03 transcript promise)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hooks = buildPipelineHooks([{ ...pre }], spawner({ code: 1, stderr: 'boom' }, []));
      const decision = await hooks.pre![0]!({ tool: 'write_file', params: {} });
      expect(decision?.deny).toBeUndefined();
      expect(decision?.note).toMatch(/hook pre "check.sh" failed \(exit 1\): boom/);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('pre hook timeout fails closed (a gate that cannot answer is not a pass)', async () => {
    const hooks = buildPipelineHooks([{ ...pre, timeoutMs: 5 }], spawner({ timedOut: true }, []));
    const decision = await hooks.pre![0]!({ tool: 'write_file', params: {} });
    expect(decision?.deny).toBe(true);
    expect(decision?.reason).toMatch(/timed out/i);
  });

  it('matcher selects by tool name; * matches everything; non-match never spawns', async () => {
    const calls: HookRequest[] = [];
    const hooks = buildPipelineHooks([{ ...pre }], spawner({}, calls));
    await hooks.pre![0]!({ tool: 'bash', params: {} });
    expect(calls).toHaveLength(0);
    await hooks.pre![0]!({ tool: 'write_file', params: {} });
    expect(calls).toHaveLength(1);
  });

  it('post hook stdout becomes a note; empty stdout is silent', async () => {
    const hooks = buildPipelineHooks(
      [{ ...post }],
      spawner({ code: 0, stdout: '2 lint errors found' }, []),
    );
    const obs = await hooks.post![0]!({ tool: 'write_file', params: {}, result: { content: 'ok' } });
    expect(obs).toEqual({ note: '2 lint errors found' });

    const quiet = buildPipelineHooks([{ ...post }], spawner({ code: 0, stdout: '  \n' }, []));
    expect(await quiet.post![0]!({ tool: 'x', params: {}, result: { content: '' } })).toBeUndefined();
  });

  it('post hook failure lands a note (transcript-visible [hook] failed) plus stderr, never breaks the turn', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hooks = buildPipelineHooks([{ ...post }], spawner({ code: 3, stderr: 'nope' }, []));
      const obs = await hooks.post![0]!({ tool: 'x', params: {}, result: { content: '' } });
      expect(obs?.note).toMatch(/hook post "observe.sh" failed \(exit 3\): nope/);
      expect(warn).toHaveBeenCalled();

      const timeoutHooks = buildPipelineHooks([{ ...post, timeoutMs: 5 }], spawner({ timedOut: true }, []));
      const tObs = await timeoutHooks.post![0]!({ tool: 'x', params: {}, result: { content: '' } });
      expect(tObs?.note).toMatch(/hook post "observe.sh" timed out/);
    } finally {
      warn.mockRestore();
    }
  });

  it('pre and post lists each carry their own hooks from mixed specs', () => {
    const hooks = buildPipelineHooks(
      [pre, post, { ...post, command: 'other.sh' }],
      spawner({}, []),
    );
    expect(hooks.pre).toHaveLength(1);
    expect(hooks.post).toHaveLength(2);
  });
});
