import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { windowsPathToGitBashPath } from '../shared/paths.js';
import type { ShellPlan } from './shell-routing.js';

const execFileAsync = promisify(execFileCb);

/**
 * Shell-init snapshots (shell-snapshot ticket 01; ZCode/Codex-proven design).
 *
 * The bash tool's DEFAULT path spawns a fresh shell per command with only
 * `-c` — the user's rc state (functions, aliases, options, PATH additions
 * from nvm/pyenv-style tools) never applies. A snapshot pays for ONE
 * login-shell at session start, records that state to a file, and later
 * commands `source` the file instead of re-parsing the rc — and after a
 * successful foreground command the final `pwd -P` is captured so the
 * session's cwd carries over (ticket 02 does the wiring).
 *
 * Two deliberate limits: NOTHING captures environment VALUES (only
 * declarations + PATH — no secret can ever land on disk, the Codex
 * credential-broker lesson); and cmd/powershell dialects never snapshot
 * (Codex's explicit `bail!` for PS/Cmd; ZCode only implements posix +
 * git-bash). Failure anywhere degrades to "no snapshot" = today's behavior.
 */

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 1_048_576;
const DEFAULT_RETENTION_DAYS = 30;

/** Injectable child-process seam (tests fake it; production uses execFile). */
export type SnapshotExecFile = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type ShellInitSnapshotKind = 'bash' | 'zsh' | 'sh';

/** A created snapshot: native path (fs) + git-bash rendering (shell text). */
export interface ShellInitSnapshot {
  path: string;
  shellPath: string;
}

/** Only the bash family snapshots; cmd returns false (never wrap). */
export function supportsShellInitSnapshot(plan: ShellPlan): plan is Extract<ShellPlan, { kind: 'bash' }> {
  return plan.kind === 'bash';
}

function detectShellKind(shellPath: string): ShellInitSnapshotKind {
  const name = path.basename(shellPath).toLowerCase();
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('bash')) return 'bash';
  return 'sh';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Shell-safe single-quoted rendering of a path for command embedding
 *  (shared by the creation script and the replay prelude/capture tail). */
export function shellSingleQuote(value: string): string {
  return shellQuote(value);
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}

function initConfigPath(shellKind: ShellInitSnapshotKind, home: string): string {
  if (shellKind === 'zsh') return path.join(home, '.zshrc');
  if (shellKind === 'bash') return path.join(home, '.bashrc');
  return path.join(home, '.profile');
}

/**
 * Build the script that runs ONE login shell and records user state into
 * SNAPSHOT_FILE: clear + unalias guard, user functions (completion-private
 * single-underscore ones filtered), shell options, aliases (winpty ones
 * dropped on msys/cygwin so headless pipes do not die), and the final PATH
 * — evaluated AFTER sourcing the rc, so toolchain PATH edits are baked in.
 * No `env` dump anywhere: values never leave memory.
 */
export function buildShellInitSnapshotCreationScript(input: {
  shellKind: ShellInitSnapshotKind;
  snapshotPath: string;
  configPath: string;
  configExists: boolean;
  pathValue: string;
}): string {
  const append = (line: string): string => `echo ${shellDoubleQuote(line)} >> "$SNAPSHOT_FILE"`;
  const lines: string[] = [
    `SNAPSHOT_FILE=${shellQuote(input.snapshotPath)}`,
    input.configExists
      ? `source ${shellDoubleQuote(input.configPath)} < /dev/null`
      : '# No user config file to source',
    '',
    '# Create/clear the snapshot file',
    'echo "# Snapshot file" >| "$SNAPSHOT_FILE"',
    '',
    '# Restore-time guard: aliases freeze into function bodies at definition',
    '# time, so every replay starts from a clean alias table.',
    append('# Unset all aliases to avoid conflicts with functions'),
    append('unalias -a 2>/dev/null || true'),
  ];

  if (input.configExists && input.shellKind === 'zsh') {
    lines.push(
      append('# Functions'),
      'typeset -f > /dev/null 2>&1',
      // Keep double-underscore helpers (__pyenv_init etc.); drop _-prefixed completions.
      "typeset +f | grep -vE '^_[^_]' | while read func; do",
      '  typeset -f "$func" >> "$SNAPSHOT_FILE"',
      'done',
      append('# Shell Options'),
      "setopt | sed 's/^/setopt /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    );
  } else if (input.configExists) {
    lines.push(
      append('# Functions'),
      'declare -F > /dev/null 2>&1',
      "declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do",
      // base64 round-trip preserves every special char in function bodies.
      "  encoded_func=$(declare -f \"$func\" | base64)",
      "  echo \"eval \\\"\\$(echo '$encoded_func' | base64 -d)\\\" > /dev/null 2>&1\" >> \"$SNAPSHOT_FILE\"",
      'done',
      append('# Shell Options'),
      'shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"',
      'set -o | grep "on" | awk \'{print "set -o " $1}\' | head -n 1000 >> "$SNAPSHOT_FILE"',
      append('shopt -s expand_aliases'),
    );
  } else {
    lines.push(append('shopt -s expand_aliases'));
  }

  lines.push(
    append('# Aliases'),
    '# On msys/cygwin drop winpty wrappers: winpty fails with "stdin is not',
    '# a tty" in headless pipes.',
    'if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then',
    "  alias | grep -v \"='winpty \" | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    'else',
    "  alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    'fi',
    '',
    // PATH evaluated after the rc source above; %q keeps $, backticks and
    // quotes inert when the snapshot is later sourced (no re-expansion).
    "printf 'export PATH=%s\\n' \"$(printf %q \"${PATH:-" + shellQuote(input.pathValue) + "}\")\" >> \"$SNAPSHOT_FILE\"",
    '',
    'if [ ! -f "$SNAPSHOT_FILE" ]; then',
    '  echo "Error: snapshot file was not created" >&2',
    '  exit 1',
    'fi',
  );
  return lines.join('\n');
}

export interface ShellInitSnapshotManagerOptions {
  /** Where shell-snapshots/ lives (runtime: the NOVA_HOME tree). */
  rootDir: string;
  /** The resolved bash executable (snapshot dialect + kind come from it). */
  shellPath: string;
  /** HOME used to find .bashrc/.zshrc/.profile. */
  home: string;
  env?: NodeJS.ProcessEnv;
  execFile?: SnapshotExecFile;
  execTimeoutMs?: number;
  now?: () => number;
}

function snapshotDir(rootDir: string): string {
  return path.join(rootDir, 'shell-snapshots');
}

function defaultExecFile(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): ReturnType<SnapshotExecFile> {
  return execFileAsync(shellPath, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
}

/**
 * Lazy, once-per-manager snapshot creator. getOrCreate caches the promise
 * (including its failure), so a broken rc costs exactly one bounded exec
 * for the whole session and every command then runs plain, like today.
 */
export function createShellInitSnapshotManager(options: ShellInitSnapshotManagerOptions): {
  getOrCreate: () => Promise<ShellInitSnapshot | undefined>;
} {
  const shellKind = detectShellKind(options.shellPath);
  const timeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  let cached: Promise<ShellInitSnapshot | undefined> | undefined;

  // The injected seam is a pure (file,args) fn and fakes ignore the timeout,
  // so the manager enforces its own bound on top of the promise (also covers
  // the default exec in case child_process ever exceeds its own timeout).
  const bounded = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('snapshot exec timed out')), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

  const create = async (): Promise<ShellInitSnapshot | undefined> => {
    try {
      const dir = snapshotDir(options.rootDir);
      fs.mkdirSync(dir, { recursive: true });
      const snapshotPath = path.join(
        dir,
        `snapshot-${shellKind}-${now()}-${Math.random().toString(36).slice(2, 8)}.sh`,
      );
      const configPath = initConfigPath(shellKind, options.home);
      const script = buildShellInitSnapshotCreationScript({
        shellKind,
        // The script runs INSIDE bash: reference the git-bash rendering.
        snapshotPath: windowsPathToGitBashPath(snapshotPath),
        configPath: windowsPathToGitBashPath(configPath),
        configExists: fs.existsSync(configPath),
        pathValue: env.PATH ?? env.Path ?? '',
      });
      const exec = options.execFile
        ?? ((file: string, args: string[]) => defaultExecFile(file, args, env, timeoutMs));
      await bounded(exec(options.shellPath, ['-c', '-l', script]), timeoutMs);
      try {
        if (!fs.statSync(snapshotPath).isFile()) return undefined;
      } catch {
        return undefined; // creation script never produced the file
      }
      return { path: snapshotPath, shellPath: windowsPathToGitBashPath(snapshotPath) };
    } catch {
      return undefined; // best-effort: no snapshot, commands keep running plain
    }
  };

  return {
    getOrCreate() {
      if (cached === undefined) cached = create();
      return cached;
    },
  };
}

/** Delete snapshot files older than the retention window; never throws. */
export function cleanupStaleShellInitSnapshots(input: {
  rootDir: string;
  retentionDays?: number;
  now?: Date;
}): { deleted: number; errors: number } {
  const dir = snapshotDir(input.rootDir);
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const nowMs = input.now?.getTime() ?? Date.now();
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const result = { deleted: 0, errors: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // missing dir = nothing to do
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(full);
      result.deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.errors += 1;
    }
  }
  return result;
}
