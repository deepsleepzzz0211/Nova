import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatView } from '../../src/tui/ChatView.js';
import { MessageBubble } from '../../src/tui/MessageBubble.js';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

const staticKind = (): 'command' | 'path' | undefined => undefined;

function assistant(content: string): DisplayMessage {
  return { role: 'assistant', content };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ChatView static partition (tui-refactor 08)', () => {
  it('renders every message once when idle', () => {
    const instance = render(
      <ChatView
        messages={[assistant('MSG-A'), assistant('MSG-B')]}
        displayKind={staticKind}
      />,
    );
    const output = instance.frames.join('');
    expect(output).toContain('MSG-A');
    expect(output).toContain('MSG-B');
    instance.unmount();
  });

  it('keeps the streaming message in the live area and does not duplicate history', async () => {
    const history = [assistant('MSG-A'), assistant('MSG-B')];
    const instance = render(
      <ChatView
        messages={[...history, assistant('STREAM-1')]}
        displayKind={staticKind}
        isStreaming={true}
      />,
    );
    instance.rerender(
      <ChatView
        messages={[...history, assistant('STREAM-1 STREAM-2')]}
        displayKind={staticKind}
        isStreaming={true}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('STREAM-1 STREAM-2');
    // Each rendered screen shows completed messages exactly once: the static
    // region holds them while only the live message re-renders.
    expect(occurrences(frame, 'MSG-A')).toBe(1);
    expect(occurrences(frame, 'MSG-B')).toBe(1);
    instance.unmount();
  });

  it('moves a finished message into the static region without duplication', async () => {
    const messages = [assistant('MSG-A'), assistant('MSG-B FINAL')];
    const instance = render(
      <ChatView messages={messages} displayKind={staticKind} isStreaming={true} />,
    );
    instance.rerender(<ChatView messages={messages} displayKind={staticKind} isStreaming={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(instance.frames.join('')).toContain('MSG-B FINAL');
    instance.unmount();
  });

  it('renders the empty-state hint when there are no messages', () => {
    const instance = render(<ChatView messages={[]} displayKind={staticKind} />);
    expect(instance.lastFrame()).toContain('Welcome to Nova');
    instance.unmount();
  });
});

describe('memoised presentation components (tui-refactor 08)', () => {
  it('MessageBubble and ToolCallView are React.memo components', () => {
    const memoType = Symbol.for('react.memo');
    expect((MessageBubble as unknown as { $$typeof: symbol }).$$typeof).toBe(memoType);
    expect((ToolCallView as unknown as { $$typeof: symbol }).$$typeof).toBe(memoType);
  });
});
