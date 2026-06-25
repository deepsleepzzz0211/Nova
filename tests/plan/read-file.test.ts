import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createReadFileTool } from '../../src/tools/read-file.js';

describe('read_file', () => {
  let tmp: string;
  const ac = new AbortController();
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads file with line numbers', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'line one\nline two\n');
    const r = await createReadFileTool().execute({ path: 'a.txt' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('1\tline one');
    expect(r.content).toContain('2\tline two');
  });

  it('errors on missing file', async () => {
    const r = await createReadFileTool().execute({ path: 'nope.txt' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBe(true);
  });

  it('detects binary files', async () => {
    fs.writeFileSync(path.join(tmp, 'b.bin'), Buffer.from([0, 1, 2, 3]));
    const r = await createReadFileTool().execute({ path: 'b.bin' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('binary');
  });

  it('supports offset+limit pagination', async () => {
    fs.writeFileSync(path.join(tmp, 'long.txt'), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
    const r = await createReadFileTool().execute({ path: 'long.txt', offset: 10, limit: 5 }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.content).toContain('line 10');
    expect(r.content).not.toContain('line 16');
  });

  it('never requires permission', () => {
    expect(createReadFileTool().requiresPermission?.({})).toBe(false);
  });
});
