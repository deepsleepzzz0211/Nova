import type { PermissionConfig } from '../config/schema.js';
import type { Tool } from '../shared/tool-contracts.js';
import { matchDangerousCommand } from './dangerous.js';
import {
  evaluateSandbox,
  extractWriteTargets,
  normalizeWritePath,
  type SandboxSettings,
} from './sandbox.js';

/** Decision returned by the permission policy. */
export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  message?: string;
}

/**
 * Evaluates whether a tool invocation should be allowed, denied, or require
 * explicit user confirmation.
 *
 * Tool identity is NOT hardcoded here (tui-refactor ticket 19): each tool
 * declares `permission: { mode: 'ask' | 'auto', message? }`, and the policy
 * layers the user's own rules on top.
 *
 * Evaluation order:
 *  1. Always-allow prefixes (command tools only — the user's own list)
 *  2. Dangerous command patterns (command tools only)
 *  3. The tool's declared permission requirement
 *  4. No declaration → ask (tools must opt in to running unconfirmed)
 */
export class PermissionPolicy {
  private readonly config: PermissionConfig;
  private readonly sandbox: SandboxSettings | null;

  constructor(config: PermissionConfig, sandbox?: SandboxSettings) {
    this.config = config;
    this.sandbox = sandbox ?? null;
  }

  check(toolName: string, params: Record<string, unknown>, tool?: Tool, cwd: string = process.cwd()): PermissionDecision {
    // Fail closed: without the tool's own declaration we cannot know what it
    // does, so the user confirms first.
    if (tool === undefined) {
      return { decision: 'ask', message: `Tool "${toolName}" has no declared permission` };
    }

    // 0. Sandbox tier 1 (batch-B ticket 01): a workspace path policy that
    // DENIES out-of-workspace writes before anything else — the always-allow
    // list and the approval dialog cannot escape it. Disabled by default.
    if (this.sandbox !== null) {
      const sandboxDecision = this.checkSandbox(tool, params, cwd);
      if (sandboxDecision !== null) return sandboxDecision;
    }

    // Command tools are identified by their declared display kind, so the
    // policy never needs to know a tool is called "bash".
    const isCommandTool = tool?.display?.kind === 'command';
    const command = isCommandTool && typeof params.command === 'string' ? params.command : '';

    // 1. User's always-allow list (prefix match on the command)
    if (command !== '') {
      const isAlwaysAllowed = this.config.alwaysAllowCommands.some(
        (prefix) => command === prefix || command.startsWith(prefix + ' '),
      );
      if (isAlwaysAllowed) {
        return { decision: 'allow' };
      }
    }

    // 2. Dangerous patterns override an auto declaration. The walk itself
    // lives in dangerous.ts (arch2 C) - permission-display renders from the
    // same function, so approval UI and policy can never drift on matching.
    const danger = matchDangerousCommand(command);
    if (danger !== null) {
      return { decision: 'ask', message: `Dangerous command detected: ${danger}` };
    }

    // 3. The tool's own declaration. A tool that declares nothing is NOT
    //    silently allowed: it must opt in to running without confirmation
    //    (ticket 19 — fail closed).
    const declared = tool.permission;
    if (declared === undefined) {
      return { decision: 'ask', message: `Tool "${toolName}" declares no permission requirement` };
    }
    return declared.mode === 'ask'
      ? { decision: 'ask', message: declared.message }
      : { decision: 'allow' };
  }

  /**
   * Tier-1 sandbox evaluation for one call: command tools get static write
   * target analysis; tools declaring the write file-access capability are
   * judged on their `path` argument. Returns null when the call carries no
   * write evidence or everything resolves inside the allowed roots.
   */
  private checkSandbox(tool: Tool, params: Record<string, unknown>, cwd: string): PermissionDecision | null {
    const settings = this.sandbox!;
    if (!settings.enabled) return null;
    if (tool.display?.kind === 'command' && typeof params.command === 'string') {
      const targets = extractWriteTargets(params.command);
      const absolute = targets.paths.map((p) => normalizeWritePath(p, cwd));
      const verdict = evaluateSandbox(settings, absolute, { unresolvable: targets.unresolvable });
      return verdict.decision === 'deny' ? { decision: 'deny', message: verdict.reason } : null;
    }
    if (tool.fileAccess === 'write' && typeof params.path === 'string') {
      const verdict = evaluateSandbox(settings, [normalizeWritePath(params.path, cwd)]);
      return verdict.decision === 'deny' ? { decision: 'deny', message: verdict.reason } : null;
    }
    return null;
  }
}
