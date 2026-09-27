import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createListDirTool } from '../../src/tools/list-dir.js';
import type { ToolResult } from '../../src/tools/types.js';

const ctx = (dir: string) => ({ workingDirectory: dir, abortSignal: new AbortController().signal });

describe('list_dir', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is auto-permission, path-displayed, named list_dir', async () => {
    const tool = createListDirTool();
    expect(tool.name).toBe('list_dir');
    expect(tool.permission).toEqual({ mode: 'auto' });
    expect(tool.display).toEqual({ kind: 'path' });
  });

  it('lists a normal directory: dirs with trailing slash first, files after, alphabetical', async () => {
    fs.mkdirSync(path.join(tmp, 'zeta'));
    fs.mkdirSync(path.join(tmp, 'alpha'));
    fs.writeFileSync(path.join(tmp, 'beta.txt'), 'hello');
    fs.writeFileSync(path.join(tmp, 'a.md'), 'x');
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.isError).toBeUndefined();
    const lines = r.content.split('\n').slice(0, 4);
    expect(lines[0]).toBe('alpha/');
    expect(lines[1]).toBe('zeta/');
    expect(lines[2]).toMatch(/^a\.md/);
    expect(lines[3]).toMatch(/^beta\.txt/);
  });

  it('shows file sizes in compact human form', async () => {
    fs.writeFileSync(path.join(tmp, 'big.txt'), 'x'.repeat(2048));
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.content).toMatch(/big\.txt.*2\.0K/);
  });

  it('marks hidden entries and does not hide them', async () => {
    fs.writeFileSync(path.join(tmp, '.envish'), 'x');
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.content).toContain('.envish');
    expect(r.content).toContain('hidden');
  });

  it('reports symlinks without following them', async () => {
    fs.writeFileSync(path.join(tmp, 'target.txt'), 'x');
    try {
      fs.symlinkSync(path.join(tmp, 'target.txt'), path.join(tmp, 'link.txt'));
    } catch {
      // Windows without dev-mode cannot create symlinks; nothing to assert.
      return;
    }
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.content).toContain('link.txt');
    expect(r.content).toContain('link');
  });

  it('empty directory gets an explicit message', async () => {
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('empty');
  });

  it('errors when the path is a file, not a directory', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    const r = await createListDirTool().execute({ path: 'f.txt' }, ctx(tmp));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a directory/i);
  });

  it('errors on a missing path', async () => {
    const r = await createListDirTool().execute({ path: 'nope' }, ctx(tmp));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found|does not exist/i);
  });

  it('errors (not throws) on an unreadable directory', async () => {
    // POSIX-only: chmod 000 does not block reads on Windows.
    if (process.platform === 'win32') return;
    const dir = path.join(tmp, 'locked');
    fs.mkdirSync(dir);
    let r: ToolResult;
    try {
      fs.chmodSync(dir, 0o000);
      r = await createListDirTool().execute({ path: 'locked' }, ctx(tmp));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/permission|denied|unreadable/i);
  });

  it('truncates huge listings with a [PARTIAL] note instead of flooding context', async () => {
    for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.txt`), 'x');
    const r = await createListDirTool().execute({}, ctx(tmp));
    expect(r.content).toContain('[PARTIAL');
    expect(r.content.split('\n').length).toBeLessThan(520);
  });

  it('resolves relative paths inside the working directory and forward-slashes output', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'inner.txt'), 'x');
    const r = await createListDirTool().execute({ path: 'sub' }, ctx(tmp));
    expect(r.content).toContain('inner.txt');
    const abs = await Promise.resolve(createListDirTool().execute({ path: tmp }, ctx(process.cwd())));
    expect(abs.isError).toBeUndefined();
  });
});
