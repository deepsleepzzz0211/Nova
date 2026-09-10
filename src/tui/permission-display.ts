import { DANGEROUS_PATTERNS } from '../permission/dangerous.js';
import { COMMAND_TOOLS, PATH_TOOLS } from './tool-summary.js';

/** A permission decision: deny, allow once, or always for this session. */
export type PermissionDecision = 'deny' | 'allow' | 'always';

/**
 * Pure helpers for the permission dialog (tui-refactor ticket 04): typed
 * one-line call descriptions, danger detection (no hardcoded tool names in
 * the UI), and the session-scoped always-allow rule store. No Ink/React.
 */

const SUMMARY_CAP = 80;

/** One-line human description of the call (command / path / compact JSON). */
export function describeCall(name: string, args: Record<string, unknown> | null): string {
  if (args === null) return '(unparseable arguments)';
  if (COMMAND_TOOLS.has(name) && typeof args.command === 'string') {
    return cap(args.command);
  }
  if (PATH_TOOLS.has(name)) {
    const p = args.path ?? args.file_path ?? args.filePath;
    if (typeof p === 'string') return cap(p);
  }
  try {
    return cap(JSON.stringify(args));
  } catch {
    return cap(String(args));
  }
}

/** Danger reason for a call, or null (command tools only, no hardcoded names). */
export function dangerReason(name: string, args: Record<string, unknown> | null): string | null {
  if (!COMMAND_TOOLS.has(name) || args === null) return null;
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return null;
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/** Primary argument identifying a call (command, path, or stable JSON). */
function primaryArg(name: string, args: Record<string, unknown> | null): string {
  if (args === null) return '<unparseable>';
  if (COMMAND_TOOLS.has(name) && typeof args.command === 'string') return args.command;
  if (PATH_TOOLS.has(name)) {
    const p = args.path ?? args.file_path ?? args.filePath;
    if (typeof p === 'string') return p;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '<unparseable>';
  }
}

/** Session-scoped always-allow rules: (tool, primary argument) pairs. */
export class SessionAlwaysRules {
  private readonly pairs = new Set<string>();

  /** Record an always-allow decision for this call. */
  add(name: string, args: Record<string, unknown> | null): void {
    this.pairs.add(name + ' ' + primaryArg(name, args));
  }

  /** Whether an identical (tool, primary argument) pair was always-allowed. */
  matches(name: string, args: Record<string, unknown> | null): boolean {
    return this.pairs.has(name + ' ' + primaryArg(name, args));
  }
}

function cap(s: string): string {
  return s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP) + '...' : s;
}