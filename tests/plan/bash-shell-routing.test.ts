import { describe, it, expect } from 'vitest';
import { createBashTool } from '../../src/tools/bash.js';
import { resolveShellFromProcess, type ShellPlan } from '../../src/tools/shell-routing.js';

// Tool-level wiring over the real spawn path. The machine-true assertions run
// on every platform because the default resolution yields a bash -c plan both
// on POSIX and on Windows-with-Git-Bash; cmd-plan tests are win32-gated.

const ctx = () => ({ workingDirectory: process.cwd(), abortSignal: new AbortController().signal });
const isWin = process.platform === 'win32';

function withPlan(plan: ShellPlan) {
  return createBashTool({ resolvePlan: () => plan });
}

describe('bash tool over the routing layer', () => {
  it('executes POSIX pipelines through the default plan (bash -c)', async () => {
    const r = await createBashTool().execute({ command: 'echo hi | tr a-z A-Z' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('HI');
  });

  it('a missing NOVA_SHELL path surfaces as a tool error, not a crash or silent fallback', async () => {
    const tool = createBashTool({
      resolvePlan: () => {
        throw new Error('NOVA_SHELL points to a missing executable: D:\\nope\\bash.exe');
      },
    });
    const r = await tool.execute({ command: 'echo hi' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('missing executable');
  });

  (isWin ? it : it.skip)('cmd plan really runs through cmd.exe', async () => {
    const r = await withPlan({ kind: 'cmd', label: 'cmd.exe' }).execute({ command: 'echo cmdworks' }, ctx());
    expect(r.content).toContain('cmdworks');
    expect(r.isError).toBeUndefined();
  });

  // Use the bash executable the real resolver finds on this machine (any
  // platform where a bash plan exists); skip those cases otherwise.
  const real = (() => {
    try {
      const p = resolveShellFromProcess();
      return p.kind === 'bash' ? p : null;
    } catch {
      return null;
    }
  })();

  if (real !== null) {
    const bashPlan = real;
    it('bash plan runs && chains through the resolved interpreter', async () => {
      const r = await withPlan(bashPlan).execute({ command: 'echo a && echo b' }, ctx());
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain('a');
      expect(r.content).toContain('b');
    });

    it('bash stdin transport feeds the command via -s', async () => {
      const r = await withPlan({ ...bashPlan, transport: 'stdin' }).execute(
        { command: 'echo stdinworks' },
        ctx(),
      );
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain('stdinworks');
    });
  }
});
