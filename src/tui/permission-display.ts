import { DANGEROUS_PATTERNS } from '../permission/dangerous.js';
import { cap, primaryArg, type DisplayKindResolver } from './tool-summary.js';

/**
 * Pure helpers for the permission dialog (tui-refactor ticket 04): typed
 * one-line call descriptions, danger detection, and the session-scoped
 * always-allow rule store. No Ink/React.
 *
 * Tool-display knowledge comes from the Tool registry (Tool.display /
 * registry.displayKindFor, tui-refactor ticket 14) — this module holds no
 * tool names of its own.
 */

/** A permission decision: deny, allow once, or always for this session. */
export type PermissionDecision = 'deny' | 'allow' | 'always';

/**
 * One-line human description of the call: bash -> command, path tools ->
 * path, fallback -> compact JSON. Null args render a placeholder.
 */
export function describeCall(
  name: string,
  args: Record<string, unknown> | null,
  kindOf?: DisplayKindResolver,
): string {
  if (args === null) return '(unparseable arguments)';
  const primary = primaryArg(name, args, kindOf);
  if (primary !== null) return cap(primary);
  try {
    return cap(JSON.stringify(args));
  } catch {
    return cap(String(args));
  }
}

/**
 * Danger reason for a call, or null. Dangerous command patterns only apply
 * to command tools.
 */
export function dangerReason(
  name: string,
  args: Record<string, unknown> | null,
  kindOf?: DisplayKindResolver,
): string | null {
  if (kindOf?.(name) !== 'command' || args === null) return null;
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return null;
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/**
 * Session-scoped "always allow" rules.
 *
 * Matching is EXACT on (tool, primary argument) — intentionally stricter
 * than the ticket's "参数模式" wording: a remembered approval must never
 * cover a different command. Dangerous calls are never eligible for
 * always-allow (enforced in the dialog/decision path, not here).
 */
export class SessionAlwaysRules {
  private readonly pairs = new Set<string>();

  /** Stable rule key: tool + primary argument (JSON fallback for opaque calls). */
  private static key(
    name: string,
    args: Record<string, unknown> | null,
    kindOf?: DisplayKindResolver,
  ): string {
    return (
      name +
      ' ' +
      (primaryArg(name, args, kindOf) ?? (args === null ? '<unparseable>' : JSON.stringify(args)))
    );
  }

  /** Record an always-allow decision for this call. */
  add(name: string, args: Record<string, unknown> | null, kindOf?: DisplayKindResolver): void {
    this.pairs.add(SessionAlwaysRules.key(name, args, kindOf));
  }

  /** Whether an identical (tool, primary argument) pair was always-allowed. */
  matches(name: string, args: Record<string, unknown> | null, kindOf?: DisplayKindResolver): boolean {
    return this.pairs.has(SessionAlwaysRules.key(name, args, kindOf));
  }
}
