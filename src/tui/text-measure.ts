import stringWidth from 'string-width';

/**
 * Display-width measurement (zcode-borrow ticket 09): every layout decision
 * that predicts how tall/wide a block renders must count TERMINAL COLUMNS, not
 * UTF-16 code units — CJK glyphs and emoji occupy two cells, combining marks
 * and zero-width characters none. Undercounting makes fullscreen layout
 * reflow (jitter) once the renderer wraps the same text correctly.
 */

/** Split into extended grapheme clusters; falls back to code points. */
const hasSegmenter = typeof Intl.Segmenter === 'function';
const segmenter = hasSegmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function graphemes(text: string): string[] {
  if (segmenter) {
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Terminal columns the text occupies (wide chars = 2, zero-width = 0). */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/**
 * Rows the text occupies when wrapped to `columns` display cells. Empty
 * paragraphs and a zero-width budget still count as one line.
 */
export function wrappedLineCount(text: string, columns: number): number {
  if (columns <= 0) return 1;
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    lines += Math.max(1, Math.ceil(stringWidth(paragraph) / columns));
  }
  return lines;
}

/**
 * Cut `text` to at most `maxColumns` display cells (the marker counts against
 * the budget), appending `marker` when truncated. Iterates grapheme clusters
 * so emoji sequences and combining marks are never split.
 */
export function truncateToWidth(
  text: string,
  maxColumns: number,
  marker = '…',
): string {
  if (stringWidth(text) <= maxColumns) return text;
  const budget = Math.max(0, maxColumns - stringWidth(marker));
  let used = 0;
  let out = '';
  for (const grapheme of graphemes(text)) {
    const width = stringWidth(grapheme);
    if (used + width > budget) break;
    out += grapheme;
    used += width;
  }
  return `${out}${marker}`;
}

/** Right-pad `text` with spaces to exactly `columns` display cells. */
export function padToWidth(text: string, columns: number): string {
  const pad = columns - stringWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}
