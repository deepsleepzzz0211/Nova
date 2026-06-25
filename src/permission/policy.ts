import type { PermissionConfig } from '../config/schema.js';
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
 * Evaluation order:
 *  1. Always-allow list (bash prefix match)
 *  2. Dangerous-pattern detection (bash)
 *  3. Read-only tools → allow
 *  4. write_file → ask
 *  5. bash (default) → ask
 *  6. MCP tools (mcp_ prefix) → ask
 *  7. Default → allow
 */
export class PermissionPolicy {
  private readonly config: PermissionConfig;

  constructor(config: PermissionConfig) {
    this.config = config;
  }

  check(toolName: string, params: Record<string, unknown>): PermissionDecision {
    // Extract command for bash tools
    const command = typeof params.command === 'string' ? params.command : '';

    // 1. Always-allow list: bash command starts with an always-allowed prefix
    if (toolName === 'bash' && command) {
      const isAlwaysAllowed = this.config.alwaysAllowCommands.some(
        (prefix) => command === prefix || command.startsWith(prefix + ' '),
      );
      if (isAlwaysAllowed) {
        return { decision: 'allow' };
      }
    }

    // 2. Dangerous patterns for bash commands
    if (toolName === 'bash' && command) {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return { decision: 'ask', message: `Dangerous command detected: ${reason}` };
        }
      }
    }

    // 3. Read-only / editing tools → always allow
    if (toolName === 'read_file' || toolName === 'edit_file' || toolName === 'web_search' || toolName === 'web_fetch') {
      return { decision: 'allow' };
    }

    // 4. write_file → always ask
    if (toolName === 'write_file') {
      return { decision: 'ask', message: 'File write requires confirmation' };
    }

    // 5. bash (default path, not caught by rules 1-2) → ask
    if (toolName === 'bash') {
      return { decision: 'ask', message: 'Bash command requires confirmation' };
    }

    // 6. MCP tools (mcp_ prefix) → ask
    if (toolName.startsWith('mcp_')) {
      return { decision: 'ask', message: 'MCP tool requires confirmation' };
    }

    // 7. Default → allow
    return { decision: 'allow' };
  }
}
