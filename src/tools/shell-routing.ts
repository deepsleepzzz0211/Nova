import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { toSlashes } from '../shared/paths.js';

/**
 * Shell routing for command tools (windows-shell ticket 01), modeled on the
 * proven Pi implementation: models are trained overwhelmingly on bash, so
 * Windows runs must reach a real bash (Git Bash first, then bash on PATH),
 * with cmd.exe only as an announced last resort. Explicit configuration is
 * honored strictly — a missing custom path is an error, never a silent
 * downgrade (a silently wrong interpreter costs more debugging time than a
 * loud startup error).
 */

export interface ShellProbe {
  exists(path: string): boolean;
  /** First executable found for `exe` (win32: `where`), or null. */
  which(exe: string): string | null;
}

export type ShellPlan = {
  kind: 'bash';
  path: string;
  /**
   * 'argv' = `bash -c <command>`; 'stdin' = `bash -s` with the command piped
   * in — required for the legacy WSL bash shim, whose argv quoting corrupts
   * anything but simple commands.
   */
  transport: 'argv' | 'stdin';
  label: string;
  fallbackNotice?: string;
} | {
  kind: 'cmd';
  label: string;
  fallbackNotice?: string;
};

/** Resolution failure that must surface to the user, not degrade silently. */
export class ShellRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellRouteError';
  }
}

/** Legacy WSL bash shim (translated /bin/bash) — argv is broken there. */
export function isLegacyWslBash(path: string): boolean {
  const normalized = path.replace(/\//g, '\\').toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

const CMD_FALLBACK_NOTICE =
  'No bash shell found on Windows — falling back to cmd.exe. POSIX syntax (pipes, ' +
  "&&-chains with $(), for loops) will behave differently; install Git for Windows " +
  '(https://git-scm.com/download/win) or set NOVA_SHELL to a bash.exe path.';

/** Real probe over the actual filesystem + PATH lookup. */
export const defaultShellProbe: ShellProbe = {
  exists: (p) => existsSync(p),
  which: (exe) => {
    if (process.platform === 'win32') {
      try {
        const res = spawnSync('where', [exe], { encoding: 'utf-8', timeout: 5_000, windowsHide: true });
        if (res.status !== 0 || !res.stdout) return null;
        const first = res.stdout.trim().split(/\r?\n/)[0];
        return first && existsSync(first) ? first : null;
      } catch {
        return null;
      }
    }
    try {
      const res = spawnSync('which', [exe], { encoding: 'utf-8', timeout: 5_000 });
      if (res.status !== 0 || !res.stdout) return null;
      const first = res.stdout.trim().split(/\r?\n/)[0];
      return first || null;
    } catch {
      return null;
    }
  },
};

export interface ResolveShellInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  probe: ShellProbe;
}

/** Resolve the command interpreter for one platform view (fully injected). */
export function resolveShell(input: ResolveShellInput): ShellPlan {
  const { platform, env, probe } = input;
  if (platform !== 'win32') {
    // POSIX behavior is deliberately unchanged: `bash -c` as today.
    return { kind: 'bash', path: 'bash', transport: 'argv', label: 'bash' };
  }

  const raw = (env.NOVA_SHELL ?? '').trim();
  if (raw.toLowerCase() === 'cmd') {
    return { kind: 'cmd', label: 'cmd.exe (NOVA_SHELL=cmd)' };
  }
  if (raw) {
    if (!probe.exists(raw)) {
      throw new ShellRouteError(`NOVA_SHELL points to a missing executable: ${raw}`);
    }
    return {
      kind: 'bash',
      path: raw,
      transport: isLegacyWslBash(raw) ? 'stdin' : 'argv',
      label: `custom shell (${raw})`,
    };
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  for (const candidate of [`${programFiles}\\Git\\bin\\bash.exe`, `${programFilesX86}\\Git\\bin\\bash.exe`]) {
    if (probe.exists(candidate)) {
      return { kind: 'bash', path: candidate, transport: 'argv', label: 'Git Bash' };
    }
  }

  const onPath = probe.which('bash.exe');
  if (onPath) {
    return {
      kind: 'bash',
      path: onPath,
      transport: isLegacyWslBash(onPath) ? 'stdin' : 'argv',
      label: 'bash (PATH)',
    };
  }

  return { kind: 'cmd', label: 'cmd.exe (fallback)', fallbackNotice: CMD_FALLBACK_NOTICE };
}

/** Convenience wrapper bound to the real process environment. */
export function resolveShellFromProcess(): ShellPlan {
  return resolveShell({ platform: os.platform(), env: process.env, probe: defaultShellProbe });
}

export interface SpawnInvocation {
  file: string;
  args: string[];
  stdinText?: string;
}

/** Translate a plan + command into the exact spawn call (never the Node `shell:` option). */
export function buildSpawnInvocation(plan: ShellPlan, command: string): SpawnInvocation {
  if (plan.kind === 'cmd') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (plan.transport === 'stdin') {
    return { file: plan.path, args: ['-s'], stdinText: `${command}\n` };
  }
  return { file: plan.path, args: ['-c', command] };
}

/**
 * Human/model-facing one-line description of a resolved plan, for the
 * environment section of the system prompt (windows-shell ticket 02).
 * `note` is present only when the interpreter is a capability downgrade.
 */
export function summarizeShellPlan(plan: ShellPlan): { shell: string; note?: string } {
  if (plan.kind === 'bash') {
    return {
      shell: `${plan.label.startsWith('custom') ? 'custom bash' : plan.label} (${toSlashes(plan.path)}) — POSIX-compatible bash; bash syntax (pipes, &&, $(), for) works`,
    };
  }
  return {
    shell: `cmd.exe [${plan.label}]`,
    ...(plan.fallbackNotice !== undefined
      ? { note: 'POSIX bash syntax (pipes to unix tools, $(), for-loops) will NOT work here — install Git for Windows or set NOVA_SHELL to a bash.exe path.' }
      : {}),
  };
}
