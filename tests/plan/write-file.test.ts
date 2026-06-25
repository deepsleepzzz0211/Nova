import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createWriteFileTool } from '../../src/tools/write-file.js';

describe('write_file', () => {
  let tmp: string;
  const ac = new AbortController();
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('creates new file', async () => {
    await createWriteFileTool().execute({ path: path.join(tmp, 'new.txt'), content: 'hello' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(fs.readFileSync(path.join(tmp, 'new.txt'), 'utf-8')).toBe('hello');
  });

  it('creates parent dirs', async () => {
    const p = path.join(tmp, 'a', 'b', 'c.txt');
    await createWriteFileTool().execute({ path: p, content: 'deep' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(fs.readFileSync(p, 'utf-8')).toBe('deep');
  });

  it('appends in append mode', async () => {
    const p = path.join(tmp, 'app.txt');
    fs.writeFileSync(p, 'first\n');
    await createWriteFileTool().execute({ path: p, content: 'second\n', mode: 'append' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(fs.readFileSync(p, 'utf-8')).toBe('first\nsecond\n');
  });

  it('always requires permission', () => {
    expect(createWriteFileTool().requiresPermission?.({})).toBe(true);
  });
});
