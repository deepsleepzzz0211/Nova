import type { ToolDisplay } from '../tools/types.js';
import type { DisplayToolCall } from './display-types.js';
import { truncateToWidth } from './text-measure.js';
import { theme } from './theme.js';
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
    if (primary !== null) return cap(tidyValue(primary));
    // Non-primary args read as muted key: value pairs, never raw JSON
    // (tui-redesign 05).
    const pairs = Object.entries(parsed).map(([k, v]) => `${k}: ${tidyValue(valueText(v))}`);
    if (pairs.length > 0) return cap(pairs.join(' · '));
    return '';
  }
  return cap(tidyValue(argsJson));
}

/** Non-string argument values render as compact JSON text. */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** The typed primary argument of a call: command string, path, pattern, or null. */
export function primaryArg(
  name: string,
  parsed: Record<string, unknown> | null,
  kindOf?: DisplayKindResolver,
): string | null {
  if (parsed === null) return null;
  const kind = kindOf?.(name)?.kind;
  if (kind === 'command' && typeof parsed.command === 'string') return parsed.command;
  if (kind === 'path' && typeof parsed.path === 'string') return parsed.path;
  if (kind === 'pattern' && typeof parsed.pattern === 'string') return parsed.pattern;
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
  pending: { icon: '⚠', color: theme.toolPending },
  running: { icon: '⠋', color: theme.primary }, // running: spinner in accent (tui-redesign 05)
  done: { icon: '✓', color: theme.toolSuccess },
  error: { icon: '✗', color: theme.toolError },
};

/** Verb titles for the tool rows (tui-redesign 05): `✓ Read`, `✗ Bash`. */
const VERBS: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  append_file: 'Append',
  bash: 'Bash',
  web_search: 'Search',
  web_fetch: 'Fetch',
  todo_write: 'Todos',
  memory_write: 'Memory',
  spawn_subagent: 'Agent',
  grep: 'Grep',
};

/** Display verb for a tool name; unknown names title-case their words. */
export function toolVerb(name: string): string {
  const known = VERBS[name];
  if (known !== undefined) return known;
  const words = name.split(/[_\s]+/).filter((w) => w.length > 0);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Secret-shaped values are never echoed into a summary row (ZCode [redacted]). */
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,})/;

/** Tidy one argument value: redact secrets, bracket long payloads. */
export function tidyValue(v: string): string {
  if (SECRET_VALUE_RE.test(v)) return '[redacted]';
  if (v.length > 60) return `[${v.length} chars]`;
  return v;
}

/** Sub-second shows ms, else one-decimal seconds (123ms / 1.2s). */
export function formatDurationMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Pretty-print tool arguments for the expanded view (fallback: raw). */
export function formatArgs(argsJson: string, parsed: Record<string, unknown> | null): string {
  return parsed === null ? argsJson : JSON.stringify(parsed, null, 2);
}

/** Cap a display string at SUMMARY_CAP TERMINAL COLUMNS (shared with permission-display). */
export function cap(s: string): string {
  return truncateToWidth(s, SUMMARY_CAP, '...');
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

/** One rendered row of a message's tool-call list (tui-redesign 05). */
export type ToolRow =
  | { type: 'single'; call: DisplayToolCall }
  | {
      type: 'group';
      verb: string;
      count: number;
      ids: string[];
      latestSummary: string;
      status: 'done' | 'error';
    };

/**
 * Fold runs of >=2 consecutive, already-finished calls of the same tool into
 * one count row (`✓ Read x3 (latest ...)`). Live calls (pending/running) and
 * any run whose member is expanded stay as individual rows.
 */
export function groupToolCalls(
  calls: readonly DisplayToolCall[],
  isExpanded: (id: string) => boolean,
  kindOf?: DisplayKindResolver,
): ToolRow[] {
  const rows: ToolRow[] = [];
  let i = 0;
  while (i < calls.length) {
    const first = calls[i];
    let j = i + 1;
    while (j < calls.length && calls[j].name === first.name) j += 1;
    const run = calls.slice(i, j);
    const foldable =
      run.length >= 2 &&
      run.every((c) => c.status === 'done' || c.status === 'error') &&
      !run.some((c) => isExpanded(c.id));
    if (foldable) {
      const latest = run[run.length - 1];
      rows.push({
        type: 'group',
        verb: toolVerb(first.name),
        count: run.length,
        ids: run.map((c) => c.id),
        latestSummary: summarizeCall(latest.name, latest.arguments, kindOf),
        status: run.some((c) => c.status === 'error') ? 'error' : 'done',
      });
    } else {
      for (const c of run) rows.push({ type: 'single', call: c });
    }
    i = j;
  }
  return rows;
}
