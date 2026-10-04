import type { SpawnHook } from '../hooks/config-hooks.js';
import { resolveShellFromProcess, buildSpawnInvocation, type ShellPlan } from '../tools/shell-routing.js';
import { createShellLauncher, unsandboxed } from '../tools/shell-launcher.js';

/**
 * The production hook spawner (CLI glue): resolves the shell through the
 * same routing the bash tool uses (Git Bash on win32) and runs the hook
 * command with the event JSON on stdin.
 *
 * ARCH TICKET 02 NOTE — this is the ONE deliberate non-wrapped path:
 * declarative hooks are user-supplied commands and run OUTSIDE the tier-2
 * low-integrity wrap (same documented boundary as Claude Code: command
 * hooks execute with the parent's full access). It still goes through the
 * shared launcher seam, with the choice made VISIBLE here (the explicit
 * `unsandboxed` adapter) rather than an optional parameter forgotten at a
 * call site.
 */
const hookLauncher = createShellLauncher({ sandbox: unsandboxed });

export const spawnHook: SpawnHook = async (req) => {
  let plan: ShellPlan;
  try {
    plan = resolveShellFromProcess();
  } catch (err) {
    return { code: 127, stdout: '', stderr: `hook shell unavailable: ${String(err)}` };
  }
  const invocation = buildSpawnInvocation(plan, req.command);
  const res = await hookLauncher.capture(
    { ...invocation, stdinText: req.inputJson },
    { cwd: process.cwd(), timeoutMs: req.timeoutMs },
  );
  return { code: res.code, stdout: res.stdout, stderr: res.stderr, ...(res.timedOut ? { timedOut: true } : {}) };
};
