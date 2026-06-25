import { describe, it, expect } from 'vitest';
import { createBashTool } from '../../src/tools/bash.js';
import * as os from 'os';

describe('bash tool', () => {
  const ac = new AbortController();
  const cwd = os.tmpdir();

  it('executes command and returns output', async () => {
    const r = await createBashTool().execute({ command: 'echo hello' }, { workingDirectory: cwd, abortSignal: ac.signal });
    expect(r.content).toContain('hello');
  });

  it('returns exit code 0 on success', async () => {
    const r = await createBashTool().execute({ command: 'exit 0' }, { workingDirectory: cwd, abortSignal: ac.signal });
    expect(r.metadata?.exitCode).toBe(0);
  });

  it('returns non-zero exit code on failure', async () => {
    const r = await createBashTool().execute({ command: 'exit 42' }, { workingDirectory: cwd, abortSignal: ac.signal });
    expect(r.metadata?.exitCode).toBe(42);
  });

  it('captures stderr', async () => {
    const r = await createBashTool().execute({ command: 'echo err >&2' }, { workingDirectory: cwd, abortSignal: ac.signal });
    expect(r.content).toContain('err');
  });

  it('always requires permission', () => {
    expect(createBashTool().requiresPermission?.({})).toBe(true);
  });
});
