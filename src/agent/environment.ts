import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Environment information injected into the system prompt. */
export interface PromptEnvironment {
  workingDirectory: string;
  platform: string;
  gitBranch?: string;
  gitStatus?: string;
  isGitRepo: boolean;
  /** Resolved command interpreter for the bash tool (windows-shell 02). */
  shell?: string;
  /** Downgrade warning shown when the interpreter is a capability fallback. */
  shellNote?: string;
  /** PowerShell availability (win32 only). */
  powershell?: string;
  /**
   * Sandbox tier note (batch-B ticket 01). Only present when the tier-1
   * workspace path policy is ACTIVE — the default prompt stays byte-stable.
   */
  sandbox?: string;
}

/** Shell facts gathered by the DI root (the agent layer never resolves shells itself). */
export interface ShellFacts {
  shell: string;
  shellNote?: string;
  powershell?: string;
}

/** Options for environment gathering (test seams). */
export interface GatherOptions {
  /** Test seam: pretend the directory is not inside a git repository. */
  pretendNoGit?: boolean;
  /** Pre-resolved interpreter facts (from the tools layer). */
  shellFacts?: ShellFacts;
  /** Sandbox tier note rendered into the env facts when the policy is on. */
  sandboxNote?: string;
}

function runGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Collect environment facts for the system prompt: working directory,
 * platform, git branch and short status. Git info is omitted outside a
 * repository or when git is unavailable.
 */
export function gatherEnvironment(cwd: string, options?: GatherOptions): PromptEnvironment {
  const env: PromptEnvironment = {
    workingDirectory: cwd,
    platform: process.platform,
    isGitRepo: false,
    ...(options?.shellFacts?.shell !== undefined ? { shell: options.shellFacts.shell } : {}),
    ...(options?.shellFacts?.shellNote !== undefined ? { shellNote: options.shellFacts.shellNote } : {}),
    ...(options?.shellFacts?.powershell !== undefined ? { powershell: options.shellFacts.powershell } : {}),
    ...(options?.sandboxNote !== undefined ? { sandbox: options.sandboxNote } : {}),
  };

  if (options?.pretendNoGit) {
    return env;
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined) {
    return env;
  }

  env.isGitRepo = true;
  env.gitBranch = branch;

  // Short status: at most 10 lines to keep the prompt lean
  const status = runGit(['status', '--porcelain'], cwd);
  if (status) {
    const lines = status.split('\n');
    const shown = lines.slice(0, 10).join('\n');
    env.gitStatus = lines.length > 10 ? `${shown}\n... (${lines.length} changed paths)` : shown;
  } else {
    env.gitStatus = '(clean)';
  }

  return env;
}

/**
 * Load project-level agent instructions from the working directory.
 * Prefers AGENTS.md, falls back to CLAUDE.md. Returns undefined when absent.
 */
export function loadProjectInstructions(projectDir: string): string | undefined {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const full = path.join(projectDir, name);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      if (content.trim().length > 0) {
        return content;
      }
    } catch {
      // Try the next candidate
    }
  }
  return undefined;
}
