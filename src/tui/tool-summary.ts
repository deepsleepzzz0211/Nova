import type { ToolDisplay } from '../tools/types.js';
/**
 * Pure helpers for tool-call display (tui-refactor ticket 05): spinner
 * frames, typed one-line summaries, and output folding. No Ink/React.
 */

/** Braille spinner frames (pi-style). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Deterministic frame for a tick (any integer; wraps). */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n];
}

/** Resolver for a tool's declared display metadata (registry.displayFor). */
export type DisplayKindResolver = (name: string) => ToolDisplay | undefined;

/** Cap for the fallback summary. */
const SUMMARY_CAP = 200;

/**
 * One-line summary for a folded tool block: typed per tool kind
 * (bash -> command, path tools -> path), falling back to a compact JSON
 * preview capped at SUMMARY_CAP.
 */
export function summarizeCall(
  name: string,
  argsJson: string,
  kindOf?: DisplayKindResolver,
): string {
  const parsed = parseToolArgs(argsJson);

  if (parsed !== null) {
    const primary = primaryArg(name, parsed, kindOf);
    if (primary !== null) return cap(primary);
    return cap(JSON.stringify(parsed));
  }
  return cap(argsJson);
}

/** The typed primary argument of a call: command string, path, or null. */
export function primaryArg(
  name: string,
  parsed: Record<string, unknown> | null,
  kindOf?: DisplayKindResolver,
): string | null {
  if (parsed === null) return null;
  const kind = kindOf?.(name)?.kind;
  if (kind === 'command' && typeof parsed.command === 'string') return parsed.command;
  if (kind === 'path' && typeof parsed.path === 'string') return parsed.path;
  return null;
}

/** Parse tool-call arguments, returning null when the JSON is unusable. */
export function parseToolArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Status → icon/color in ONE place (ToolCallView renders it directly). */
export const STATUS_STYLE: Record<
  'pending' | 'running' | 'done' | 'error',
  { icon: string; color: string }
> = {
  pending: { icon: '⚠', color: 'yellow' },
  running: { icon: '⠋', color: 'yellow' }, // running uses the animated spinner
  done: { icon: '✓', color: 'green' },
  error: { icon: '✗', color: 'red' },
};

/** Pretty-print tool arguments for the expanded view (fallback: raw). */
export function formatArgs(argsJson: string, parsed: Record<string, unknown> | null): string {
  return parsed === null ? argsJson : JSON.stringify(parsed, null, 2);
}

/** Cap a display string (shared with permission-display). */
export function cap(s: string): string {
  return s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP) + '...' : s;
}

export interface FoldedLines {
  text: string;
  hidden: number;
}

/** Fold text beyond `max` lines, appending a pi-style hidden count. */
export function foldLines(text: string, max: number): FoldedLines {
  const lines = text.split('\n');
  if (lines.length <= max) return { text, hidden: 0 };
  const shown = lines.slice(0, max).join('\n');
  const hidden = lines.length - max;
  return { text: shown + `\n... (${hidden} more lines)`, hidden };
}
