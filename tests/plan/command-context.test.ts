import { describe, it, expect, vi } from 'vitest';
import { createCommandContext, restoredConversation } from '../../src/tui/command-context.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

function makeLoop(overrides: Record<string, unknown> = {}): never {
  return {
    setProvider: vi.fn(),
    setModel: vi.fn(),
    undoTurns: vi.fn(() => ({ undone: true, undoneTurns: 1 })),
    compactNow: vi.fn(async () => ({ compacted: true, beforeTokens: 100, afterTokens: 10 })),
    getMessages: vi.fn(() => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: null },
      { role: 'user', content: '' },
    ]),
    ...overrides,
  } as never;
}

describe('command context adapter (tui-refactor 15 review fixes)', () => {
  it('restoredConversation keeps only non-empty user/assistant text', () => {
    const loop = makeLoop();
    expect(restoredConversation(loop)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('appends user and system messages through the updater', () => {
    const messages: DisplayMessage[] = [];
    const ctx = createCommandContext({
      loop: makeLoop(),
      updateMessages: (updater) => messages.splice(0, messages.length, ...updater(messages)),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    ctx.appendUserMessage('echo');
    ctx.appendSystemMessage('note');
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(['user:echo', 'system:note']);
  });

  it('switchModel applies provider/model and refreshes model info incl. cost', () => {
    const loop = makeLoop();
    const setModelInfo = vi.fn();
    const llm = { name: 'p' } as never;
    const ctx = createCommandContext({
      loop,
      updateMessages: vi.fn(),
      setModelInfo,
      resolveSwitch: () => ({
        ok: true,
        message: 'switched',
        llm,
        model: 'm2',
        contextWindow: 1234,
        providerName: 'prov',
        cost: { input: 1, output: 2 },
      }),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    expect(ctx.switchModel('m2')).toEqual({ message: 'switched' });
    expect((loop as unknown as { setProvider: ReturnType<typeof vi.fn> }).setProvider).toHaveBeenCalledWith(llm);
    expect(setModelInfo).toHaveBeenCalledWith({
      model: 'm2',
      contextWindow: 1234,
      providerName: 'prov',
      cost: { input: 1, output: 2 },
    });
  });

  it('switchModel reports unavailability without touching the loop', () => {
    const loop = makeLoop();
    const ctx = createCommandContext({
      loop,
      updateMessages: vi.fn(),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    expect(ctx.switchModel('x')).toEqual({ message: 'Model switching unavailable.' });
    expect((loop as unknown as { setProvider: ReturnType<typeof vi.fn> }).setProvider).not.toHaveBeenCalled();
  });

  it('undoTurns returns the restored conversation only when something was undone', () => {
    const loop = makeLoop();
    const ctx = createCommandContext({
      loop,
      updateMessages: vi.fn(),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    const r = ctx.undoTurns(1);
    expect(r.undone).toBe(true);
    expect(r.restored).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    const loop2 = makeLoop({ undoTurns: vi.fn(() => ({ undone: false, undoneTurns: 0 })) });
    const ctx2 = createCommandContext({
      loop: loop2,
      updateMessages: vi.fn(),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    expect(ctx2.undoTurns(1)).toEqual({ undone: false, undoneTurns: 0, restored: [] });
  });

  it('compact stays silent on success (the loop already announced it)', async () => {
    const ctx = createCommandContext({
      loop: makeLoop(),
      updateMessages: vi.fn(),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    expect(await ctx.compact()).toEqual({ note: '' });

    const loop2 = makeLoop({ compactNow: vi.fn(async () => ({ compacted: false })) });
    const ctx2 = createCommandContext({
      loop: loop2,
      updateMessages: vi.fn(),
      setModelInfo: vi.fn(),
      runUpdate: vi.fn(async () => ({ message: 'ok' })),
    });
    expect(await ctx2.compact()).toEqual({ note: '[nothing to compact — context is small]' });
  });
});
