import { describe, it, expect } from 'vitest';
import { runGrepSearch, runGlobListing, type RipgrepResult, type RipgrepRun, type SearchEnv, type SearchRequest } from '../../src/tools/ripgrep-search.js';
import { toSlashes } from '../../src/shared/paths.js';

const BS = String.fromCharCode(92);

// arch2 ticket B1: these are now exercised THROUGH the facades (the seam the
// tools and callers cross), not by importing internals. The engine is faked
// via the injected RipgrepRun so argv and rendering are asserted deterministically.
// The WASM engine needs forward-slash paths on Windows (backslashes are eaten by
// the guest), so path normalization is a first-class contract here.

function fakeRun(result: Partial<RipgrepResult> = {}): { run: RipgrepRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: RipgrepRun = async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}

// workingDirectory disjoint from the emitted absolute paths, so relativize()
// falls through to the full forward-slash path identically on win + posix.
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
const argv = (calls: string[][]) => calls[0];

describe('glob normalization (through the --glob argv)', () => {
  it('leaves a bare basename pattern untouched', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', glob: '*.ts' }), env(f.run));
    expect(argv(f.calls)).toContain('*.ts');
  });
  it('prepends **/ to a root-relative slash pattern so it matches absolute paths', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', glob: 'src/**/*.ts' }), env(f.run));
    expect(argv(f.calls)).toContain('**/src/**/*.ts');
  });
  it('does not double-prefix an already-globbed pattern', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', glob: '**/*.tsx' }), env(f.run));
    expect(argv(f.calls)).toContain('**/*.tsx');
  });
  it('preserves an absolute-anchored pattern', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', glob: '/etc/*.conf' }), env(f.run));
    expect(argv(f.calls)).toContain('/etc/*.conf');
  });
  it('converts backslashes then normalizes', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', glob: 'src' + BS + 'components' + BS + '*.tsx' }), env(f.run));
    expect(argv(f.calls)).toContain('**/src/components/*.tsx');
  });
});

describe('toSlashes', () => {
  it('converts backslash separators to forward slashes', () => {
    expect(toSlashes('D:' + BS + 'project' + BS + 'codeagent' + BS + 'src')).toBe('D:/project/codeagent/src');
  });
  it('leaves already-posix paths untouched', () => {
    expect(toSlashes('src/tools/grep.ts')).toBe('src/tools/grep.ts');
  });
});

describe('runGrepSearch argv contract', () => {
  it('defaults: files-with-matches, NUL-safe, no user config', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ outputMode: 'files', pattern: 'cacheRetention', searchPath: 'D:/ws/src' }), env(f.run));
    const a = argv(f.calls);
    expect(a).toContain('--no-config');
    expect(a).toContain('-l');
    expect(a).toContain('--null');
    expect(a).toContain('-e');
    expect(a).toContain('cacheRetention');
    expect(a).toContain('--');
    expect(a[a.length - 1]).toBe('D:/ws/src');
    expect(a.join(' ')).not.toContain(String.fromCharCode(92));
  });

  it('content mode uses --json and maps -B/-A', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: 'foo', searchPath: '/tmp/x', beforeContext: 2, afterContext: 3 }), env(f.run));
    const a = argv(f.calls);
    expect(a).toContain('--json');
    expect(a).not.toContain('-l');
    expect(a).toContain('-B');
    expect(a[a.indexOf('-B') + 1]).toBe('2');
    expect(a).toContain('-A');
    expect(a[a.indexOf('-A') + 1]).toBe('3');
  });

  it('maps -C for a symmetric context', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: 'foo', searchPath: '/tmp/x', context: 4 }), env(f.run));
    const a = argv(f.calls);
    expect(a).toContain('-C');
    expect(a[a.indexOf('-C') + 1]).toBe('4');
  });

  it('ignores context flags outside content mode', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: 'foo', searchPath: '/tmp/x', outputMode: 'count', context: 5, beforeContext: 1 }), env(f.run));
    const a = argv(f.calls);
    expect(a).not.toContain('-C');
    expect(a).not.toContain('-B');
    expect(a).toContain('-c');
  });

  it('maps the boolean flags: -i, -o, -U multiline', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: 'foo', searchPath: '/tmp/x', ignoreCase: true, onlyMatching: true, multiline: true }), env(f.run));
    const a = argv(f.calls);
    expect(a).toContain('-i');
    expect(a).toContain('-o');
    expect(a).toContain('-U');
    expect(a).toContain('--multiline-dotall');
  });

  it('maps the type filter', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: 'foo', searchPath: '/tmp/x', outputMode: 'files', type: 'js' }), env(f.run));
    const a = argv(f.calls);
    expect(a).toContain('--type');
    expect(a).toContain('js');
  });

  it('treats a dash-leading pattern as a pattern, not a flag', async () => {
    const f = fakeRun();
    await runGrepSearch(req({ pattern: '--debug', searchPath: '/tmp/x', outputMode: 'files' }), env(f.run));
    const a = argv(f.calls);
    expect(a[a.indexOf('-e') + 1]).toBe('--debug');
  });
});

