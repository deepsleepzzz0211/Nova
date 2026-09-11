import { describe, it, expect } from 'vitest';
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  findMatches,
  osc52Copy,
  parseMouseSequence,
  stepMatch,
} from '../../src/tui/fullscreen-input.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

const msg = (content: string): DisplayMessage => ({ role: 'assistant', content });

describe('fullscreen input helpers (tui-refactor 13)', () => {
  it('parses SGR wheel events in both directions', () => {
    expect(parseMouseSequence('\u001b[<64;10;5M')).toEqual({ kind: 'wheel', direction: 'up', amount: 1 });
    expect(parseMouseSequence('\u001b[<65;10;5M')).toEqual({ kind: 'wheel', direction: 'down', amount: 1 });
  });

  it('parses clicks and rejects non-mouse input', () => {
    expect(parseMouseSequence('\u001b[<0;3;4M')).toEqual({ kind: 'click', x: 3, y: 4 });
    expect(parseMouseSequence('a')).toBeNull();
    expect(parseMouseSequence('\u001b[A')).toBeNull();
  });

  it('enables and disables the same mouse modes', () => {
    expect(MOUSE_ENABLE).toContain('?1000h');
    expect(MOUSE_ENABLE).toContain('?1006h');
    expect(MOUSE_DISABLE).toContain('?1000l');
    expect(MOUSE_DISABLE).toContain('?1006l');
  });

  it('encodes a clipboard payload as OSC 52', () => {
    const escape = osc52Copy('hello');
    expect(escape.startsWith('\u001b]52;c;')).toBe(true);
    expect(escape.endsWith('\u0007')).toBe(true);
    expect(escape).toContain(Buffer.from('hello').toString('base64'));
  });

  it('finds matches case-insensitively and skips empty queries', () => {
    const messages = [msg('Alpha'), msg('beta ALPHA'), msg('gamma')];
    expect(findMatches(messages, 'alpha').map((m) => m.messageIndex)).toEqual([0, 1]);
    expect(findMatches(messages, '   ')).toEqual([]);
    expect(findMatches(messages, 'nope')).toEqual([]);
  });

  it('searches thinking text too and returns a snippet', () => {
    const messages: DisplayMessage[] = [{ role: 'assistant', content: '', thinking: 'reasoned about widgets' }];
    const matches = findMatches(messages, 'widget');
    expect(matches).toHaveLength(1);
    expect(matches[0].snippet).toContain('widget');
  });

  it('steps through matches with wraparound', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(0, -1, 1)).toBe(-1);
  });
});
