import * as fs from 'fs';
import * as path from 'path';

/**
 * Sandbox tier 1 (batch-B ticket 01 / gap G2-P1): a workspace path policy
 * enforced BEFORE the approval layer. With `sandbox.workspaceWrite = false`
 * (i.e. the sandbox is ON), any write targeting outside the workspace — plus
 * the explicit allow-list (the NOVA_HOME tree) — is DENIED outright: no
 * dialog, no always-allow escape. Default config leaves the sandbox off, so
 * today's behavior is byte-identical unless the user opts in.
 */

/** Effective sandbox settings derived from config. */
export interface SandboxSettings {
  /** False = tier 1 inactive (pass everything through to the old pipeline). */
  enabled: boolean;
  /** Realpath of the project workspace root. */
  workspaceRoot: string;
  /** Extra roots that may always be written (e.g. the NOVA_HOME tree). */
  allowRoots: string[];
}

/** Static analysis result for one shell command line. */
export interface WriteTargets {
  /** Write targets as written in the command (relative or absolute). */
  paths: string[];
  /** A write evidence existed but its target could not be statically resolved. */
  unresolvable: boolean;
}

export type SandboxVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string };

/**
 * Commands that CREATE/MODIFY/DELETE files. Deliberately conservative: the
 * cost of a false "needs check" is one analysis pass; the cost of a miss is
 * an escaped write.
 */
const WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'tee', 'dd', 'install',
  'truncate', 'ln', 'rsync', 'tar', 'unzip', 'git',
]);

/** Redirect sinks that never touch the filesystem. */
const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd/1', '/dev/fd/2']);

const REDIRECT_RE = /\d*>{1,2}\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;

function stripQuotes(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

function hasInterpolation(token: string): boolean {
  return token.includes('$') || token.includes('`') || token.includes('{') || token.includes('*');
}

/** First word of a command segment, normalized (drop windows .exe, path). */
function segmentCommandName(segment: string): string {
  const first = segment.trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Split a command line into simple sequential segments (&&, ||, ;, |, newline). */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\||\n|\bthen\b/).map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Statically extract write targets from a shell command. Only the common
 * shapes are resolved; anything a determined obfuscator could hide is the
 * job of tier 2 (OS-level), not string analysis.
 */
export function extractWriteTargets(command: string): WriteTargets {
  const paths: string[] = [];
  let unresolvable = false;

  // 1. Redirections anywhere in the line.
  for (const match of command.matchAll(REDIRECT_RE)) {
    const raw = stripQuotes(match[1] ?? '');
    if (raw === '' || NULL_SINKS.has(raw)) continue;
    if (hasInterpolation(raw)) {
      unresolvable = true;
      continue;
    }
    paths.push(raw);
  }

  // 2. Known write commands: every non-flag argument is a potential target.
  for (const seg of segments(command)) {
    const name = segmentCommandName(seg);
    if (!WRITE_COMMANDS.has(name)) continue;
    const tokens = seg
      .split(/\s+/)
      .slice(1)
      .map(stripQuotes)
      .filter((t) => t !== '' && !t.startsWith('-') && !t.startsWith('>') && !t.startsWith('<'));
    if (tokens.length === 0) {
      unresolvable = true; // a write command with no statically visible target
      continue;
    }
    for (const token of tokens) {
      if (hasInterpolation(token)) {
        unresolvable = true;
        continue;
      }
      paths.push(token);
    }
  }

  return { paths, unresolvable };
}

/**
 * Canonicalize a write target: nearest existing ancestor through
 * `realpathSync.native` (resolves symlinks, 8.3 names, case), remainder kept
 * lexically for not-yet-existing files.
 */
export function normalizeWritePath(targetPath: string, cwd: string): string {
  const abs = path.resolve(cwd, targetPath);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.normalize(abs);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function contains(ancestor: string, node: string): boolean {
  const a = process.platform === 'win32' ? ancestor.toLowerCase() : ancestor;
  const n = process.platform === 'win32' ? node.toLowerCase() : node;
  return n === a || n.startsWith(a + path.sep);
}

/**
 * Decide a set of already-resolved absolute write paths (resolved by the
 * CALLER with normalizeWritePath against the tool's cwd).
 */
export function evaluateSandbox(
  settings: SandboxSettings,
  absolutePaths: string[],
  evidence?: { unresolvable?: boolean },
): SandboxVerdict {
  if (!settings.enabled) return { decision: 'allow' };

  const roots = [settings.workspaceRoot, ...settings.allowRoots].map((r) => normalizeWritePath(r, r));
  for (const p of absolutePaths) {
    const norm = normalizeWritePath(p, process.cwd());
    if (!roots.some((r) => contains(r, norm))) {
      return {
        decision: 'deny',
        reason:
          `sandbox (workspaceWrite=false) refused a write outside the workspace: ${p}. ` +
          'Set sandbox.workspaceWrite = true to allow out-of-workspace writes again.',
      };
    }
  }
  if (evidence?.unresolvable === true) {
    return {
      decision: 'deny',
      reason:
        'sandbox (workspaceWrite=false) refused: the command writes a target that could not be resolved ' +
        'statically (variable/interpolated path). Set sandbox.workspaceWrite = true to allow it again.',
    };
  }
  return { decision: 'allow' };
}
