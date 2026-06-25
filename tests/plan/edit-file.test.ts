import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createEditFileTool } from '../../src/tools/edit-file.js';

describe('edit_file', () => {
  let tmp: string;
  const ac = new AbortController();
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('replaces unique string', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world\n');
    const r = await createEditFileTool().execute({ path: path.join(tmp, 'a.txt'), old_string: 'hello', new_string: 'bye' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf-8')).toBe('bye world\n');
  });

  it('errors when not found', async () => {
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'hello\n');
    const r = await createEditFileTool().execute({ path: path.join(tmp, 'b.txt'), old_string: 'nope', new_string: 'x' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not found');
  });

  it('errors on ambiguous match', async () => {
    fs.writeFileSync(path.join(tmp, 'c.txt'), 'foo bar foo\n');
    const r = await createEditFileTool().execute({ path: path.join(tmp, 'c.txt'), old_string: 'foo', new_string: 'baz' }, { workingDirectory: tmp, abortSignal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('ambiguous');
  });

  it('never requires permission', () => {
    expect(createEditFileTool().requiresPermission?.({})).toBe(false);
  });
});
