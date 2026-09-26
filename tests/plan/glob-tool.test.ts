import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGlobTool } from '../../src/tools/glob.js';
import type { RipgrepRun } from '../../src/tools/ripgrep-search.js';

const ctx = (dir = '/work') => ({ workingDirectory: dir, abortSignal: new AbortController().signal });

function fakeRun(result: { code: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const run: RipgrepRun = async (args) => {
    calls.push([...args]);
    return result;
  };
  return { run, calls };
}

describe('glob tool contract (unit)', () => {
  it('is auto-permission with pattern display', () => {
    const tool = createGlobTool();
    expect(tool.name).toBe('glob');
    expect(tool.permission).toEqual({ mode: 'auto' });
    expect(tool.display).toEqual({ kind: 'pattern' });
    expect(tool.metadata?.cacheable).toBe(false);
  });

  it('description warns against literal undefined/null for the path argument', () => {
    const props = createGlobTool().parameters.properties as Record<string, { description?: string }>;
    expect(props.path.description).toMatch(/do not enter/i);
  });

  it('builds a files-with-glob invocation fenced by -- and forward slashes', async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: '', stderr: '' });
    await createGlobTool({ run }).execute({ pattern: '**/*.tsx', path: 'src' }, ctx('/work'));
    const args = calls[0];
    expect(args).toContain('--files');
    expect(args).toContain('--null');
    expect(args).toContain('--glob');
    expect(args).toContain('**/*.tsx');
    expect(args.join(' ')).not.toContain('\\');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toContain('work/src');
  });

  it('renders relative paths newest-modified first with a count header', async () => {
    // Real files so mtime sorting is exercised; the fake runner echoes them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-u-'));
    const oldF = path.join(dir, 'old.ts');
    const newF = path.join(dir, 'new.ts');
    fs.writeFileSync(oldF, '1');
    fs.writeFileSync(newF, '2');
    fs.utimesSync(oldF, new Date(2020, 1, 1), new Date(2020, 1, 1));
    fs.utimesSync(newF, new Date(2030, 1, 1), new Date(2030, 1, 1));
    const { run } = fakeRun({ code: 0, stdout: `${oldF}\u0000${newF}\u0000`, stderr: '' });
    const r = await createGlobTool({ run }).execute({ pattern: '*.ts' }, ctx(dir));
    const body = r.content.split('\n');
    expect(r.content).toContain('Found 2 files');
    expect(body[1]).toBe('new.ts');
    expect(body[2]).toBe('old.ts');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('empty result is a clean message, not an error', async () => {
    const { run } = fakeRun({ code: 1, stdout: '', stderr: '' });
    const r = await createGlobTool({ run }).execute({ pattern: '*.nope' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('No files found');
  });

  it('maps invalid glob (exit 2) to a tool error with engine text', async () => {
    const { run } = fakeRun({ code: 2, stdout: '', stderr: 'rg: glob pattern error\n' });
    const r = await createGlobTool({ run }).execute({ pattern: '[unclosed' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('glob pattern error');
  });

  it('paginates with head_limit/offset and echoes the applied window', async () => {
    const many = Array.from({ length: 6 }, (_, i) => `/work/f${i}.ts\u0000`).join('');
    const { run } = fakeRun({ code: 0, stdout: many, stderr: '' });
    const r = await createGlobTool({ run }).execute({ pattern: '*.ts', head_limit: 2, offset: 2 }, ctx());
    expect(r.content).toContain('f2.ts');
    expect(r.content).toContain('f3.ts');
    expect(r.content).not.toContain('f4.ts');
    expect(r.content).toContain('Found 6 files');
    expect(r.content).toMatch(/limit: 2.*offset: 2/);
  });
});

describe('glob tool on the real engine (integration)', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-rg-'));
    fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/util'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/components/Button.tsx'), 'export const B = 1;\n');
    fs.writeFileSync(path.join(root, 'src/util/helper.ts'), 'export const h = 1;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds nested extension matches', async () => {
    const r = await createGlobTool().execute({ pattern: '**/*.tsx' }, ctx(root));
    expect(r.content).toContain('src/components/Button.tsx');
    expect(r.content).toContain('Found 1 file');
  });

  it('directory-prefix patterns work', async () => {
    const r = await createGlobTool().execute({ pattern: 'src/**/*.ts', path: '.' }, ctx(root));
    expect(r.content).toContain('src/util/helper.ts');
    expect(r.content).not.toContain('Button.tsx');
  });

  it('backslash input from the model still matches on Windows (normalized)', async () => {
    const r = await createGlobTool().execute({ pattern: 'src\\**\\*.ts' }, ctx(root));
    expect(r.content).toContain('src/util/helper.ts');
  });
});
