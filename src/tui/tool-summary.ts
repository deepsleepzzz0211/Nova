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

/** Tools whose first string arg is the display summary. */
const COMMAND_TOOLS = new Set(['bash']);

const PATH_TOOLS = new Set(['read', 'read_file', 'write', 'write_file', 'edit']);

/** Cap for the fallback summary. */
const SUMMARY_CAP = 80;

/**
 * One-line summary for a folded tool block: typed per tool kind
 * (bash -> command, path tools -> path), falling back to a compact JSON
 * preview capped at 80 chars.
 */
export function summarizeCall(name: string, argsJson: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (parsed !== null) {
    if (COMMAND_TOOLS.has(name) && typeof parsed.command === 'string') {
      return cap(parsed.command);
    }
    if (PATH_TOOLS.has(name)) {
      const p = parsed.path ?? parsed.file_path ?? parsed.filePath;
      if (typeof p === 'string') return cap(p);
    }
  }
  // Fallback: compact JSON preview (parse already succeeded above).
  if (parsed !== null) return cap(JSON.stringify(parsed));
  return cap(argsJson);
}

function cap(s: string): string {
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
