import { describe, it, expect } from 'vitest';
import { partitionMessages } from '../../src/tui/message-partition.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

function msg(content: string): DisplayMessage {
  return { role: 'assistant', content };
}

describe('partitionMessages (tui-refactor 08)', () => {
  it('keeps every message static when idle', () => {
    const messages = [msg('a'), msg('b'), msg('c')];
    const { staticItems, liveMessage } = partitionMessages(messages, false);
    expect(staticItems).toHaveLength(3);
    expect(liveMessage).toBeNull();
  });

  it('holds the streaming last message out of the static region', () => {
    const messages = [msg('a'), msg('b'), msg('streaming…')];
    const { staticItems, liveMessage } = partitionMessages(messages, true);
    expect(staticItems.map((m) => m.content)).toEqual(['a', 'b']);
    expect(liveMessage?.content).toBe('streaming…');
  });

  it('moves a finished message into the static region once streaming ends', () => {
    const streaming = [msg('a'), msg('b')];
    const before = partitionMessages(streaming, true);
    expect(before.staticItems).toHaveLength(1);

    const after = partitionMessages(streaming, false);
    expect(after.staticItems).toHaveLength(2); // appended to Static once
    expect(after.liveMessage).toBeNull();
  });

  it('handles the empty conversation', () => {
    expect(partitionMessages([], false)).toEqual({ staticItems: [], liveMessage: null });
    expect(partitionMessages([], true)).toEqual({ staticItems: [], liveMessage: null });
  });

  it('keeps static item identity stable across streaming deltas', () => {
    const base = [msg('a'), msg('b')];
    const first = partitionMessages([...base, msg('partial')], true);
    const second = partitionMessages([...base, msg('partial longer')], true);
    // Same static objects (no re-render churn in Ink's Static region).
    expect(second.staticItems[0]).toBe(first.staticItems[0]);
    expect(second.staticItems[1]).toBe(first.staticItems[1]);
    expect(second.staticItems).toHaveLength(first.staticItems.length);
  });
});
