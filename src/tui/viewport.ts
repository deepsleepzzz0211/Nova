import type { DisplayMessage } from './display-types.js';

/**
 * Fullscreen viewport (tui-refactor ticket 12): which slice of the
 * conversation fits in a fixed number of rows, anchored at the newest
 * message by default (follow-end) and scrollable by whole messages.
 *
 * Line counts are estimates — the renderer keeps using the real components
 * (markdown, tool blocks), so estimation only decides *how many* messages
 * are shown, never how they look.
 */
export interface ViewportOptions {
  /** Rows available for the transcript (terminal height minus chrome). */
  rows: number;
  /** Messages scrolled back from the newest (0 = follow end). */
  offset: number;
  /** Ids of expanded tool blocks (their results take extra lines). */
  expandedToolIds?: ReadonlySet<string>;
  /** Usable width, for wrapping estimates. */
  width?: number;
}

export interface ViewportSlice {
  /** Messages to render, oldest first. */
  messages: DisplayMessage[];
  /** Messages hidden above the window (for a "N earlier" hint). */
  hiddenAbove: number;
  /** Whether the window reaches the newest message. */
  atBottom: boolean;
  /** Largest usable offset (so callers can clamp). */
  maxOffset: number;
}

const DEFAULT_WIDTH = 80;

/** Estimated display lines for one message (approximation, see above). */
export function estimateMessageLines(
  message: DisplayMessage,
  options: { width?: number; expanded?: boolean } = {},
): number {
  const width = options.width ?? DEFAULT_WIDTH;
  let lines = 0;

  if (message.thinking !== undefined && message.thinking !== '') {
    lines += Math.ceil(message.thinking.length / width) + 1; // + dim marker line
  }
  if (message.content !== '') {
    lines += Math.max(1, Math.ceil(message.content.length / width));
  }
  for (const call of message.toolCalls ?? []) {
    lines += 1; // summary line
    if (options.expanded === true && call.result !== undefined) {
      const resultLines = call.result.split('\n').length;
      lines += 1 + Math.min(resultLines, 20); // + "Result:" and its fold cap
    }
  }
  return Math.max(1, lines);
}

/** Total estimated lines for a message list. */
export function estimateTotalLines(
  messages: DisplayMessage[],
  options: { width?: number; expandedToolIds?: ReadonlySet<string> } = {},
): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      estimateMessageLines(message, {
        width: options.width,
        expanded: message.toolCalls?.some((call) => options.expandedToolIds?.has(call.id) === true),
      }),
    0,
  );
}

/**
 * Select the message window that fits `rows`, keeping the newest messages
 * when `offset` is 0 (follow end) and walking backwards by whole messages as
 * the offset grows.
 */
export function viewportSlice(messages: DisplayMessage[], options: ViewportOptions): ViewportSlice {
  const { rows, offset, expandedToolIds, width } = options;
  if (messages.length === 0) {
    return { messages: [], hiddenAbove: 0, atBottom: true, maxOffset: 0 };
  }

  const lineBudget = Math.max(1, rows);
  const lineCount = (message: DisplayMessage): number =>
    estimateMessageLines(message, {
      width,
      expanded: message.toolCalls?.some((call) => expandedToolIds?.has(call.id) === true),
    });

  /** Window ending just before `end`, walking backwards within the budget. */
  const windowEndingAt = (end: number): { start: number; end: number } => {
    let used = 0;
    let start = end;
    while (start > 0) {
      const lines = lineCount(messages[start - 1]);
      // Always keep at least one message, even if it alone exceeds the budget.
      if (used + lines > lineBudget && start < end) break;
      used += lines;
      start--;
      if (used >= lineBudget) break;
    }
    return { start, end };
  };

  // How far the view can scroll: the bottom window defines the visible count.
  const bottom = windowEndingAt(messages.length);
  const visibleCount = bottom.end - bottom.start;
  const maxOffset = Math.max(0, messages.length - visibleCount);

  const effectiveOffset = Math.max(0, Math.min(offset, maxOffset));
  const end = messages.length - effectiveOffset;
  const { start } = windowEndingAt(end);

  return {
    messages: messages.slice(start, end),
    hiddenAbove: start,
    atBottom: end === messages.length,
    maxOffset,
  };
}
