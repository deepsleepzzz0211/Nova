import { spawn } from 'child_process';
import type { SpawnHook } from '../hooks/config-hooks.js';
import { resolveShellFromProcess, buildSpawnInvocation, type ShellPlan } from '../tools/shell-routing.js';

/**
 * The production hook spawner (CLI glue): resolves the shell through the
 * same routing the bash tool uses (Git Bash on win32) and runs the hook
 * command with the event JSON on stdin. Lives in the cli layer so
 * src/hooks stays free of tool-layer imports (architecture ratchet).
 */
export const spawnHook: SpawnHook = (req) =>
  new Promise((resolve) => {
    let plan: ShellPlan;
    try {
      plan = resolveShellFromProcess();
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: `hook shell unavailable: ${String(err)}` });
      return;
    }
    const inv = buildSpawnInvocation(plan, req.command);
    const child = spawn(inv.file, inv.args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, req.timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.write(req.inputJson);
    child.stdin.end();
  });
