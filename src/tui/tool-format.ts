/**
 * Pure text-formatting helpers for the tool-call display layer (arch2 ticket
 * B4, split out of tool-summary.ts): the braille spinner, tool-argument
 * parse/redact, duration formatting, and output folding. No display-model
 * coupling, no Ink/React, no imports — a leaf both tool-summary.ts and the
 * views can reach. tool-summary.ts keeps the tool-CALL row model; this module
 * is the string-level formatting vocabulary.
 */

/** Braille spinner frames (pi-style). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Deterministic frame for a tick (any integer; wraps). */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n];
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
