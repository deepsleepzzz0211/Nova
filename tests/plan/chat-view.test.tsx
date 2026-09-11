import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatView } from '../../src/tui/ChatView.js';
import { MessageBubble } from '../../src/tui/MessageBubble.js';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

const staticKind = (): 'command' | 'path' | undefined => undefined;
const user = (content: string): DisplayMessage => ({ role: 'user', content });
const assistant = (content: string): DisplayMessage => ({ role: 'assistant', content });

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ChatView static partition (tui-refactor 08)', () => {
  it('renders every message once when idle', () => {
    const instance = render(
      <ChatView messages={[user('U-1'), assistant('MSG-A')]} displayKind={staticKind} />,
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('U-1');
    expect(frame).toContain('MSG-A');
    instance.unmount();
  });

  it('does not re-render the static region across stream deltas', async () => {
    const finalised = [user('U-1'), assistant('A-1')];
    const staticRenders: string[] = [];
    const liveRenders: string[] = [];
    const probe = (region: 'static' | 'live', message: DisplayMessage): void => {
      (region === 'static' ? staticRenders : liveRenders).push(message.content);
    };
    const instance = render(
      <ChatView
        messages={[...finalised, user('U-2'), assistant('partial')]}
        displayKind={staticKind}
        renderProbe={probe}
      />,
    );
    const staticAfterFirst = staticRenders.length;
    expect(staticAfterFirst).toBe(2);
    expect(liveRenders).toContain('partial');

    instance.rerender(
      <ChatView
        messages={[...finalised, user('U-2'), assistant('partial longer')]}
        displayKind={staticKind}
        renderProbe={probe}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
    // Static region untouched; only the live region re-rendered.
    expect(staticRenders.length).toBe(staticAfterFirst);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('partial longer');
    expect(occurrences(frame, 'A-1')).toBe(1);
    instance.unmount();
  });

  it('keeps a streaming answer live even when a mid-turn notice is appended', () => {
    const messages = [
      user('U-1'),
      assistant('A-1'),
      user('U-2'),
      assistant('partial answer'),
      { role: 'system', content: '[subagent started]' } as DisplayMessage,
    ];
    const instance = render(<ChatView messages={messages} displayKind={staticKind} />);
    const frame = instance.lastFrame() ?? '';
    // The in-flight answer is still printed once, in the live region, and
    // was not duplicated by the mid-turn notice.
    expect(occurrences(frame, 'partial answer')).toBe(1);
    expect(frame).toContain('[subagent started]');
    instance.unmount();
  });

  it('reprints the conversation when the static epoch changes (/undo remount)', () => {
    const restored = [user('U-1'), assistant('A-1')];
    const instance = render(
      <ChatView messages={restored} displayKind={staticKind} staticEpoch={0} />,
    );
    instance.rerender(
      <ChatView messages={restored} displayKind={staticKind} staticEpoch={1} />,
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('U-1');
    expect(frame).toContain('A-1');
    instance.unmount();
  });

  it('renders a 500-message conversation without losing the tail', () => {
    const messages: DisplayMessage[] = [];
    for (let i = 0; i < 250; i++) {
      messages.push(user('Q-' + String(i)));
      messages.push(assistant('A-' + String(i)));
    }
    const instance = render(<ChatView messages={messages} displayKind={staticKind} />);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Q-249');
    expect(frame).toContain('A-249');
    expect(frame).toContain('Welcome'.length > 0 ? 'A-249' : '');
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
