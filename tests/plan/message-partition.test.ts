import { describe, it, expect } from 'vitest';
import { partitionMessages, latestToolId } from '../../src/tui/message-partition.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

const user = (content: string): DisplayMessage => ({ role: 'user', content });
const assistant = (content: string): DisplayMessage => ({ role: 'assistant', content });
const system = (content: string): DisplayMessage => ({ role: 'system', content });

describe('partitionMessages (tui-refactor 08)', () => {
  it('keeps everything live before any user message exists', () => {
    const messages = [system('starting up'), system('ready')];
    const { staticItems, liveItems } = partitionMessages(messages);
    expect(staticItems).toHaveLength(0);
    expect(liveItems).toHaveLength(2);
  });

  it('moves completed turns into the static region', () => {
    const messages = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      assistant('a2 partial'),
    ];
    const { staticItems, liveItems } = partitionMessages(messages);
    expect(staticItems.map((m) => m.content)).toEqual(['q1', 'a1']);
    expect(liveItems.map((m) => m.content)).toEqual(['q2', 'a2 partial']);
  });

  it('keeps mid-turn notices live so a streaming answer is never flushed early', () => {
    // A subagent/compaction notice appended while the answer streams must
    // not move the in-flight assistant message into the static region.
    const messages = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      assistant('partial ans'),
      system('[subagent started]'),
    ];
    const { staticItems, liveItems } = partitionMessages(messages);
    expect(staticItems.map((m) => m.content)).toEqual(['q1', 'a1']);
    expect(liveItems.some((m) => m.content === 'partial ans')).toBe(true);
    expect(liveItems).toHaveLength(3);
  });

  it('keeps the latest turn live so tool blocks stay expandable', () => {
    const withTool: DisplayMessage = {
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', status: 'done' }],
    };
    const { liveItems } = partitionMessages([user('q'), withTool]);
    expect(liveItems[1]).toBe(withTool);
  });

  it('handles the empty conversation', () => {
    expect(partitionMessages([])).toEqual({ staticItems: [], liveItems: [] });
  });

  it('keeps static item identity stable across streaming deltas', () => {
    const finalised = [user('q1'), assistant('a1')];
    const first = partitionMessages([...finalised, user('q2'), assistant('partial')]);
    const second = partitionMessages([...finalised, user('q2'), assistant('partial longer')]);
    expect(second.staticItems[0]).toBe(first.staticItems[0]);
    expect(second.staticItems[1]).toBe(first.staticItems[1]);
    expect(second.staticItems).toHaveLength(first.staticItems.length);
    // The live region grows with the delta instead.
    expect(second.liveItems[1].content).toBe('partial longer');
  });

  it('a shrinking conversation (undo) yields a smaller partition (caller remounts Static)', () => {
    const before = partitionMessages([user('q1'), assistant('a1'), user('q2'), assistant('a2')]);
    const after = partitionMessages([user('q1'), assistant('a1')]);
    expect(before.staticItems).toHaveLength(2);
    expect(after.staticItems).toHaveLength(0);
    expect(after.liveItems).toHaveLength(2);
  });
});

describe('latestToolId', () => {
  it('returns the last tool call id, scanning from the newest message', () => {
    const messages: DisplayMessage[] = [
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'old', name: 'bash', arguments: '{}', status: 'done' }] },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: 'y',
        toolCalls: [
          { id: 'c1', name: 'bash', arguments: '{}', status: 'done' },
          { id: 'c2', name: 'read_file', arguments: '{}', status: 'running' },
        ],
      },
    ];
    expect(latestToolId(messages)).toBe('c2');
  });

  it('returns null when there are no tool calls', () => {
    expect(latestToolId([user('q'), assistant('a')])).toBeNull();
    expect(latestToolId([])).toBeNull();
  });
});
