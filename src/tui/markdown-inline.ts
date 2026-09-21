/**
 * Inline markdown handling for the terminal renderer (tui-redesign 07):
 * markers are stripped to plain text, EXCEPT code spans, which survive as
 * typed parts the renderer styles (green on panel).
 */

/** Inline markdown markers stripped to plain text for terminal display. */
export function inlineText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
}

/** One inline segment: plain text or a code span (tui-redesign 07). */
export interface InlinePart {
  text: string;
  code: boolean;
}

/**
 * Split inline text into plain/code parts. Code spans keep their text and
 * get styled by the renderer (green on panel); every other marker keeps
 * being stripped exactly like inlineText does.
 */
export function inlineParts(raw: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`]*)`/g;
  let last = 0;
  let pending = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    pending += raw.slice(last, m.index);
    const stripped = inlineText(pending);
    if (stripped !== '') parts.push({ text: stripped, code: false });
    parts.push({ text: m[1], code: true });
    pending = '';
    last = m.index + m[0].length;
  }
  const tail = inlineText(pending + raw.slice(last));
  if (tail !== '' || parts.length === 0) parts.push({ text: tail, code: false });
  return parts;
}
