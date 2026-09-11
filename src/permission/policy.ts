import type { PermissionConfig } from '../config/schema.js';
import type { Tool } from '../tools/types.js';
import { DANGEROUS_PATTERNS } from './dangerous.js';

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

  constructor(config: PermissionConfig) {
    this.config = config;
  }

  check(toolName: string, params: Record<string, unknown>, tool?: Tool): PermissionDecision {
    // Fail closed: without the tool's own declaration we cannot know what it
    // does, so the user confirms first.
    if (tool === undefined) {
      return { decision: 'ask', message: `Tool "${toolName}" has no declared permission` };
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

    // 2. Dangerous patterns override an auto declaration
    if (command !== '') {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return { decision: 'ask', message: `Dangerous command detected: ${reason}` };
        }
      }
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
}
