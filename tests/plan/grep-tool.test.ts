import { describe, it, expect } from 'vitest';
import { createGrepTool } from '../../src/tools/grep.js';
import type { RipgrepRun } from '../../src/tools/ripgrep-search.js';

// Tool-level behavior over an injected ripgrep runner: the WASM engine itself
// is integration-tested separately; here we pin the request/response contract
// the model sees (modes, pagination echo, error mapping, display).

const ctx = (dir = '/work') => ({ workingDirectory: dir, abortSignal: new AbortController().signal });

function fakeRun(result: { code: number; stdout: string; stderr: string }): { run: RipgrepRun; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return result;
    },
  };
}

describe('grep tool contract', () => {
  it('is auto-permission, read-only, and pattern-displayed', () => {
    const tool = createGrepTool();
    expect(tool.permission).toEqual({ mode: 'auto' });
    expect(tool.display).toEqual({ kind: 'pattern' });
    expect(tool.name).toBe('grep');
  });

  it('steers the model away from bash grep in its description', () => {
    expect(createGrepTool().description).toMatch(/prefer this over/i);
  });

  it('files mode lists relative forward-slash paths with a count header', async () => {
    const { run } = fakeRun({
      code: 0,
      stdout: '/work/src/a.ts\u0000/work/src/b.ts\u0000',
      stderr: '',
    });
    const r = await createGrepTool({ run }).execute({ pattern: 'foo' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('Found 2 files');
    expect(r.content).toContain('src/a.ts');
    expect(r.content).toContain('src/b.ts');
    expect(r.content).not.toContain('\\');
  });

  it('files mode with zero hits says so without an error flag', async () => {
    const { run } = fakeRun({ code: 1, stdout: '', stderr: '' });
    const r = await createGrepTool({ run }).execute({ pattern: 'foo' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('No files found');
  });

  it('content mode renders path:line:text and reports match totals', async () => {
    const jsonl = [
      { type: 'begin', data: { path: { text: '/work/src/a.ts' } } },
      { type: 'match', data: { path: { text: '/work/src/a.ts' }, lines: { text: 'let foo = 1\n' }, line_number: 3, submatches: [{ match: { text: 'foo' }, start: 4, end: 7 }] } },
    ];
    const { run } = fakeRun({ code: 0, stdout: jsonl.map((j) => JSON.stringify(j)).join('\n'), stderr: '' });
    const r = await createGrepTool({ run }).execute({ pattern: 'foo', output_mode: 'content' }, ctx());
    expect(r.content).toContain('src/a.ts:3:let foo = 1');
  });

  it('count mode renders path:count lines plus a summary', async () => {
    const { run } = fakeRun({ code: 0, stdout: '/work/a.ts\u00003\n/work/b.ts\u00001\n', stderr: '' });
    const r = await createGrepTool({ run }).execute({ pattern: 'foo', output_mode: 'count' }, ctx());
    expect(r.content).toContain('a.ts:3');
    expect(r.content).toContain('b.ts:1');
    expect(r.content).toContain('Found 4 total occurrences across 2 files');
  });

  it('echoes applied pagination to the model', async () => {
    const many = Array.from({ length: 5 }, (_, i) => `/work/f${i}.ts\u0000`).join('');
    const { run } = fakeRun({ code: 0, stdout: many, stderr: '' });
    const r = await createGrepTool({ run }).execute({ pattern: 'foo', head_limit: 2, offset: 1 }, ctx());
    expect(r.content).toContain('f1.ts');
    expect(r.content).toContain('f2.ts');
    expect(r.content).not.toContain('f3.ts');
    expect(r.content).toMatch(/limit: 2.*offset: 1|offset: 1/);
  });

  it('maps a ripgrep pattern error (exit 2) to a tool error with the engine message', async () => {
    const { run } = fakeRun({ code: 2, stdout: '', stderr: 'rg: regex parse error: unclosed group\n' });
    const r = await createGrepTool({ run }).execute({ pattern: '(unclosed' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('regex parse error');
  });

  it('surfaces runner failures (timeout/cancel) as tool errors', async () => {
    const run: RipgrepRun = async () => {
      throw new Error('ripgrep search timed out after 30000ms');
    };
    const r = await createGrepTool({ run }).execute({ pattern: 'foo' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('timed out');
  });

  it('searches the workspace-relative path when one is given, absolute otherwise', async () => {
    const { run, calls } = fakeRun({ code: 1, stdout: '', stderr: '' });
    await createGrepTool({ run }).execute({ pattern: 'foo', path: 'src/tools' }, ctx('/work'));
    expect(calls[0][calls[0].length - 1]).toMatch(/work.*src\/tools/);
    expect(calls[0][calls[0].length - 1]).not.toContain('\\');
    await createGrepTool({ run }).execute({ pattern: 'foo', path: '/elsewhere/deep' }, ctx('/work'));
    expect(calls[1][calls[1].length - 1]).toContain('/elsewhere/deep');
  });

  it('declares a bounded execution timeout for the pipeline', () => {
    const tool = createGrepTool();
    expect(tool.metadata?.timeout).toBeGreaterThan(1000);
    expect(tool.metadata?.timeout).toBeLessThanOrEqual(60_000);
    expect(tool.metadata?.cacheable).toBe(false);
  });
});
