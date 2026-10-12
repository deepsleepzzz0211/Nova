import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitBashPathToWindowsPath, windowsPathToGitBashPath } from '../shared/paths.js';
import {
  shellSingleQuote,
  supportsShellInitSnapshot,
  type ShellInitSnapshot,
} from './shell-init-snapshot.js';
import type { ShellPlan } from './shell-routing.js';

/**
 * Plain (non-session) bash state (shell-snapshot ticket 02): the ONE façade
 * the bash tool talks to for snapshot replay + cwd carry-over. Everything
 * degrades to "run the command as-is" — no snapshot, no wrap; no capture
 * file, no cwd move. The named-session path and the powershell tool never
 * pass through here (session shells keep their own live state).
 */

/** Replay prelude + (foreground only) the pwd -P tail around a user command. */
export function buildSnapshotReplay(input: {
  command: string;
  snapshotShellPath: string;
  cwdFileShellPath?: string;
}): string {
  const lines = [
    `source ${shellSingleQuote(input.snapshotShellPath)} 2>/dev/null || true`,
    input.command,
  ];
  if (input.cwdFileShellPath !== undefined) {
    lines.push(
      '__nova_st=$?',
      `if [ "$__nova_st" -eq 0 ]; then pwd -P > ${shellSingleQuote(input.cwdFileShellPath)}; fi`,
      'exit "$__nova_st"',
    );
  }
  return lines.join('\n');
}

export interface PlainShellState {
  /** The session's carried cwd once a command captured one; else fallback. */
  cwd(fallback?: string): string | undefined;
  /** Wrap a plain command. Background calls pass captureCwd:false. */
  wrap(plan: ShellPlan, command: string, opts: { captureCwd: boolean }): Promise<{ command: string; cwdFile?: string }>;
  /** Read + apply + remove the capture file after a foreground call. */
  settle(cwdFile: string | undefined): void;
}

export interface PlainShellStateDeps {
  /** Lazily invoked with the resolved bash path; returns the snapshot provider. */
  snapshotManagerFactory: (shellPath: string) => {
    getOrCreate: () => Promise<ShellInitSnapshot | undefined>;
  };
  /** Where per-call cwd capture files live (runtime: os.tmpdir()). */
  cwdFileDir: () => string;
}

export function createPlainShellState(deps: PlainShellStateDeps): PlainShellState {
  let manager: { getOrCreate: () => Promise<ShellInitSnapshot | undefined> } | undefined;
  let currentCwd: string | undefined;

  const snapshotFor = async (shellPath: string): Promise<ShellInitSnapshot | undefined> => {
    manager ??= deps.snapshotManagerFactory(shellPath);
    return manager.getOrCreate();
  };

  return {
    cwd(fallback) {
      return currentCwd ?? fallback;
    },

    async wrap(plan, command, opts) {
      if (!supportsShellInitSnapshot(plan)) return { command };
      const snapshot = await snapshotFor(plan.path);
      if (snapshot === undefined) return { command };
      let cwdFile: string | undefined;
      let cwdFileShellPath: string | undefined;
      if (opts.captureCwd) {
        cwdFile = path.join(deps.cwdFileDir(), `nova-cwd-${randomUUID()}`);
        cwdFileShellPath = windowsPathToGitBashPath(cwdFile);
      }
      return {
        command: buildSnapshotReplay({
          command,
          snapshotShellPath: snapshot.shellPath,
          cwdFileShellPath,
        }),
        ...(cwdFile !== undefined ? { cwdFile } : {}),
      };
    },

    settle(cwdFile) {
      if (cwdFile === undefined) return;
      try {
        const raw = fs.readFileSync(cwdFile, 'utf-8').replace(/\r?\n$/u, '');
        if (raw !== '') {
          const native = gitBashPathToWindowsPath(raw);
          try {
            if (fs.statSync(native).isDirectory()) {
              currentCwd = fs.realpathSync(native);
            }
          } catch {
            // captured dir vanished mid-flight: keep the previous cwd
          }
        }
      } catch {
        // no file = command failed before the tail; nothing to carry
      } finally {
        try {
          fs.unlinkSync(cwdFile);
        } catch {
          // cleanup is best-effort, never a tool error
        }
      }
    },
  };
}
