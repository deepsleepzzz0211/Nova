import stringWidth from 'string-width';

/**
 * Display-width measurement (zcode-borrow ticket 09): every layout decision
 * that predicts how tall a block will render must count TERMINAL COLUMNS, not
 * UTF-16 code units — CJK glyphs and emoji occupy two cells, combining marks
 * and zero-width characters none. Undercounting makes fullscreen layout
 * reflow (jitter) once the renderer wraps the same text correctly.
 */

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
 * the budget), appending `marker` when truncated. Never splits a wide glyph
 * (iterates code points, measuring each), so the result renders inside the
 * budget on real terminals.
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
  for (const char of text) {
    const width = stringWidth(char);
    if (used + width > budget) break;
    out += char;
    used += width;
  }
  return `${out}${marker}`;
}
