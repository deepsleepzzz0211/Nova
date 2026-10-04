import { describe, it, expect } from 'vitest';
import {
  runGrepSearch,
  runGlobListing,
  type RipgrepResult,
  type RipgrepRun,
  type SearchEnv,
  type SearchRequest,
} from '../../src/tools/ripgrep-search.js';

// arch2 ticket B1 (companion to ripgrep-search.test.ts): the parse + render +
// pagination + failure-mapping behaviour, asserted THROUGH the facades. The
// workingDirectory is disjoint from the emitted paths so relativize() returns
// the input identically on win + posix.

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);

function fakeRun(result: Partial<RipgrepResult> = {}): { run: RipgrepRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: RipgrepRun = async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}
function env(run: RipgrepRun, over: Partial<SearchEnv> = {}): SearchEnv {
  return {
    run,
    workingDirectory: 'C:/wd',
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    failurePrefix: 'grep failed',
    ...over,
  };
}
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  pattern: 'needle',
  searchPath: 'D:/ws/src',
  outputMode: 'content',
  ...over,
});

describe('runGrepSearch rendering per mode', () => {
  it('files mode: NUL-separated paths -> header + list', async () => {
    const f = fakeRun({ stdout: 'D:/ws/a' + NUL + 'D:/ws/b.ts' + NUL });
    const r = await runGrepSearch(req({ outputMode: 'files' }), env(f.run));
    expect(r.content).toBe('Found 2 files' + LF + 'D:/ws/a' + LF + 'D:/ws/b.ts');
  });

  it('files mode: empty engine output is the no-files header', async () => {
    const f = fakeRun();
    const r = await runGrepSearch(req({ outputMode: 'files' }), env(f.run));
    expect(r.content).toBe('No files found');
  });

  it('count mode: per-file lines + total summary', async () => {
    const stdout = ['D:/ws/a.ts' + NUL + '3', 'D:/ws/b.ts' + NUL + '1'].join(LF) + LF;
    const f = fakeRun({ stdout });
    const r = await runGrepSearch(req({ outputMode: 'count' }), env(f.run));
    expect(r.content).toContain('D:/ws/a.ts:3');
    expect(r.content).toContain('Found 4 total occurrences across 2 files.');
  });

  it('count mode: no rows is "No matches found"', async () => {
    const f = fakeRun();
    const r = await runGrepSearch(req({ outputMode: 'count' }), env(f.run));
    expect(r.content).toBe('No matches found');
  });

  it('content mode: match/context separators, line numbers, path echo', async () => {
    const lines = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'D:/ws/a.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'D:/ws/a.ts' }, lines: { text: 'hello match' + LF }, line_number: 7, submatches: [{ match: { text: 'match' }, start: 6, end: 11 }] } }),
      JSON.stringify({ type: 'context', data: { path: { text: 'D:/ws/a.ts' }, lines: { text: 'quiet line' + LF }, line_number: 8 } }),
    ].join(LF);
    const f = fakeRun({ stdout: lines });
    const r = await runGrepSearch(req({ outputMode: 'content' }), env(f.run), { showLineNumbers: true });
    expect(r.content).toContain('D:/ws/a.ts:7:hello match');
    expect(r.content).toContain('D:/ws/a.ts-8-quiet line');
  });

  it('content mode: -o joins the matched substrings', async () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'D:/ws/b.ts' }, lines: { text: 'x hit y hit' + LF }, line_number: 1, submatches: [{ match: { text: 'hit' } }, { match: { text: 'hit' } }] } });
    const f = fakeRun({ stdout: line });
    const r = await runGrepSearch(req({ outputMode: 'content', onlyMatching: true }), env(f.run), { showLineNumbers: false });
    expect(r.content).toBe('D:/ws/b.ts:hit hit');
  });

  it('content mode: hides line numbers when showLineNumbers is false', async () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'D:/ws/c.ts' }, lines: { text: 'abc' + LF }, line_number: 9 } });
    const f = fakeRun({ stdout: line });
    const r = await runGrepSearch(req({ outputMode: 'content' }), env(f.run), { showLineNumbers: false });
    expect(r.content).toBe('D:/ws/c.ts:abc');
  });

  it('content mode clips a 600-char line to 500 + ellipsis (no context flood)', async () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'D:/ws/m.ts' }, lines: { text: 'x'.repeat(600) + LF }, line_number: 1 } });
    const f = fakeRun({ stdout: line });
    const r = await runGrepSearch(req({ outputMode: 'content' }), env(f.run), { showLineNumbers: false });
    expect(r.content.length).toBeLessThanOrEqual('D:/ws/m.ts:'.length + 501);
    expect(r.content.endsWith('\u2026')).toBe(true);
  });
});

describe('pagination (through files-mode rendering)', () => {
  const many = Array.from({ length: 300 }, (_, i) => 'D:/ws/f' + i + '.ts').join(NUL) + NUL;

  it('applies the default 250 head limit with the pagination note', async () => {
    const f = fakeRun({ stdout: many });
    const r = await runGrepSearch(req({ outputMode: 'files' }), env(f.run));
    expect(r.content).toContain('Found 300 files');
    expect(r.content).toContain('[Showing results with pagination: limit: 250]');
  });

  it('limit 0 = unlimited, no note', async () => {
    const f = fakeRun({ stdout: many });
    const r = await runGrepSearch(req({ outputMode: 'files' }), env(f.run, { headLimit: 0 }));
    expect(r.content).toContain('Found 300 files');
    expect(r.content).not.toContain('pagination');
  });

  it('offsets before limiting and reports both', async () => {
    const f = fakeRun({ stdout: many });
    const r = await runGrepSearch(req({ outputMode: 'files' }), env(f.run, { headLimit: 3, offset: 4 }));
    expect(r.content).toContain('[Showing results with pagination: limit: 3, offset: 4]');
  });
});

describe('facade failure mapping', () => {
  it('a throwing runner surfaces "<failurePrefix>: <message>" as an error', async () => {
    const boom: RipgrepRun = async () => {
      throw new Error('timeout');
    };
    const r = await runGrepSearch(req(), env(boom, { failurePrefix: 'grep failed' }));
    expect(r.isError).toBe(true);
    expect(r.content).toBe('grep failed: timeout');
  });

  it('engine usage error (code 2) surfaces the first stderr line', async () => {
    const f = fakeRun({ code: 2, stderr: 'rg: regex parse error' + LF + 'second line ignored' });
    const r = await runGrepSearch(req(), env(f.run));
    expect(r.isError).toBe(true);
    expect(r.content).toBe('ripgrep error: rg: regex parse error');
  });

  it('glob maps a throw and code 2 through the same seam', async () => {
    const boom: RipgrepRun = async () => {
      throw new Error('cancelled');
    };
    const g = await runGlobListing('*.ts', 'D:/ws', env(boom, { failurePrefix: 'glob failed' }));
    expect(g.isError).toBe(true);
    expect(g.content).toBe('glob failed: cancelled');

    const f = fakeRun({ code: 2, stderr: 'rg: bad' });
    const r = await runGlobListing('*.ts', 'D:/ws', env(f.run));
    expect(r.content).toBe('ripgrep error: rg: bad');
  });

  it('glob renders a listing newest-first with the files header', async () => {
    const f = fakeRun({ stdout: 'D:/ws/z.ts' + NUL + 'D:/ws/y.ts' + NUL });
    const r = await runGlobListing('*.ts', 'D:/ws', env(f.run));
    expect(r.content.startsWith('Found 2 files')).toBe(true);
  });
});