import type { ToolDisplay } from '../tools/types.js';
import type { DisplayToolCall } from './display-types.js';
import { truncateToWidth } from './text-measure.js';
import { theme } from './theme.js';
import { parseToolArgs, tidyValue } from './tool-format.js';
/**
 * The tool-CALL row model (tui-refactor ticket 05; arch2 ticket B4 slimmed):
 * typed one-line summaries, the registry verb table, status styling, and the
 * consecutive-call grouping. Pure string formatting (spinner, arg parse,
 * duration, folding) lives in tool-format.ts; this module imports what it
 * needs (parseToolArgs, tidyValue) and owns the display MODEL. No Ink/React.
 */

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
  powershell: 'PowerShell',
  web_search: 'Search',
  web_fetch: 'Fetch',
  todo_write: 'Todos',
  memory_write: 'Memory',
  spawn_subagent: 'Agent',
  grep: 'Grep',
  glob: 'Glob',
  list_dir: 'List',
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

/** Cap a display string at SUMMARY_CAP TERMINAL COLUMNS (shared with permission-display). */
export function cap(s: string): string {
  return truncateToWidth(s, SUMMARY_CAP, '...');
}

export interface FoldedLines {
  text: string;
  hidden: number;
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
