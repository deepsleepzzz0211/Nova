import type { DisplayMessage } from './display-types.js';

/**
 * Pure helpers for the fullscreen extras (tui-refactor ticket 13): SGR mouse
 * sequence parsing, OSC 52 clipboard encoding and transcript search. Kept
 * free of React/Ink so each piece is unit-testable, and each degrades
 * independently when the terminal does not support it.
 */

/** Sequences that turn wheel/click reporting on and off (SGR extended mode). */
export const MOUSE_ENABLE = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_DISABLE = '\u001b[?1006l\u001b[?1000l';

export type MouseEvent =
  | { kind: 'wheel'; direction: 'up' | 'down'; amount: number }
  | { kind: 'click'; x: number; y: number };

/**
 * Parse an SGR mouse sequence Ink hands to useInput, e.g. '\u001b[<64;10;5M'
 * (64/65 = wheel up/down) or '\u001b[<0;10;5M' (left click). Returns null for
 * anything that is not a mouse event.
 */
export function parseMouseSequence(input: string): MouseEvent | null {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (match === null) return null;
  const button = Number.parseInt(match[1], 10);
  const x = Number.parseInt(match[2], 10);
  const y = Number.parseInt(match[3], 10);

  if ((button & 64) !== 0) {
    // 64 = wheel up, 65 = wheel down (the low bits).
    return { kind: 'wheel', direction: (button & 1) === 0 ? 'up' : 'down', amount: 1 };
  }
  return { kind: 'click', x, y };
}

/** OSC 52 escape that copies `text` to the terminal clipboard. */
export function osc52Copy(text: string): string {
  const payload = Buffer.from(text, 'utf-8').toString('base64');
  return `\u001b]52;c;${payload}\u0007`;
}

export interface TranscriptMatch {
  /** Index of the matching message in the list. */
  messageIndex: number;
  snippet: string;
}

/** Case-insensitive search over message content (thinking included). */
export function findMatches(messages: DisplayMessage[], query: string): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const matches: TranscriptMatch[] = [];
  messages.forEach((message, messageIndex) => {
    const text = [message.content, message.thinking ?? ''].filter((part) => part !== '').join('\n');
    if (text.toLowerCase().includes(needle)) {
      const at = text.toLowerCase().indexOf(needle);
      const start = Math.max(0, at - 20);
      matches.push({ messageIndex, snippet: text.slice(start, start + 80).replace(/\n/g, ' ') });
    }
  });
  return matches;
}

/** Cycle through matches (n = next, N = previous), wrapping around. */
export function stepMatch(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  return ((current + delta) % count + count) % count;
}
