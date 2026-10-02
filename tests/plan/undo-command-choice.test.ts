import { describe, it, expect, vi } from 'vitest';
import { SLASH_COMMANDS, type SlashCommandContext } from '../../src/tui/commands.js';

// context-economics ticket 03 (TUI half): /undo becomes an ask-style two-way
// revert when the undone turns touched checkpointed files — conversation-only
// or conversation + code. No touched files = today's behavior, no prompt.

const undo = SLASH_COMMANDS.find((c) => c.name === 'undo');
if (!undo) throw new Error('undo command missing');

interface FakeOpts {
  touched: string[];
  choice?: 'files' | 'chat' | 'cancel';
  defaultWithFiles?: boolean;
  undoResult?: { restored: string[]; skipped: string[] };
}

function fakeCtx(o: FakeOpts) {
  const system: string[] = [];
  const calls: Array<{ n: number; withFiles: boolean }> = [];
  const ctx: SlashCommandContext = {
    appendUserMessage: () => {},
    appendSystemMessage: (t) => {
      system.push(t);
    },
    replaceConversation: () => {},
    listModels: () => '',
    switchModel: () => ({ message: '' }),
    undoTurns: (n, opts) => {
      calls.push({ n, withFiles: opts.withFiles });
      return {
        undone: true,
        undoneTurns: n,
        restored: [],
        files: opts.withFiles ? (o.undoResult ?? { restored: o.touched, skipped: [] }) : undefined,
      };
    },
    undoFilePlan: () => o.touched,
    requestUndoChoice: vi.fn(async (): Promise<'files' | 'chat' | 'cancel'> => o.choice ?? 'chat'),
    defaultUndoWithFiles: o.defaultWithFiles ?? false,
    compact: async () => ({ note: '' }),
    update: async () => ({ message: '' }),
    statusReport: () => '',
  };
  return { ctx, system, calls };
}

describe('/undo two-way ask', () => {
  it('no checkpointed files: undoes conversation-only without prompting', async () => {
    const { ctx, system, calls } = fakeCtx({ touched: [] });
    await undo.run(ctx, '');
    expect(calls).toEqual([{ n: 1, withFiles: false }]);
    expect(ctx.requestUndoChoice).not.toHaveBeenCalled();
    expect(system.join('\n')).toContain('code changes are NOT reverted');
  });

  it('asks when files are restorable; choice "files" restores them and reports counts', async () => {
    const { ctx, system, calls } = fakeCtx({ touched: ['a.ts', 'b.ts'], choice: 'files' });
    await undo.run(ctx, '');
    expect(ctx.requestUndoChoice).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    expect(calls).toEqual([{ n: 1, withFiles: true }]);
    expect(system.join('\n')).toMatch(/restored 2 file\(s\)/);
  });

  it('choice "chat" undoes conversation only', async () => {
    const { ctx, calls } = fakeCtx({ touched: ['a.ts'], choice: 'chat' });
    await undo.run(ctx, '2');
    expect(calls).toEqual([{ n: 2, withFiles: false }]);
  });

  it('choice "cancel" changes nothing', async () => {
    const { ctx, system, calls } = fakeCtx({ touched: ['a.ts'], choice: 'cancel' });
    await undo.run(ctx, '');
    expect(calls).toEqual([]);
    expect(system.join('\n')).toContain('[undo cancelled');
  });

  it('--with-files default skips the ask and restores directly', async () => {
    const { ctx, calls } = fakeCtx({ touched: ['a.ts'], defaultWithFiles: true });
    await undo.run(ctx, '');
    expect(ctx.requestUndoChoice).not.toHaveBeenCalled();
    expect(calls).toEqual([{ n: 1, withFiles: true }]);
  });

  it('reports externally-changed files as skipped', async () => {
    const { ctx, system } = fakeCtx({
      touched: ['a.ts', 'b.ts'],
      choice: 'files',
      undoResult: { restored: ['a.ts'], skipped: ['b.ts'] },
    });
    await undo.run(ctx, '');
    const out = system.join('\n');
    expect(out).toMatch(/restored 1 file\(s\)/);
    expect(out).toMatch(/skipped 1/);
    expect(out).toContain('b.ts');
  });

  it('nothing to undo still short-circuits', async () => {
    const touched: string[] = [];
    const ctx: SlashCommandContext = {
      appendUserMessage: () => {},
      appendSystemMessage: (t) => {
        touched.push(t);
      },
      replaceConversation: () => {},
      listModels: () => '',
      switchModel: () => ({ message: '' }),
      undoTurns: () => ({ undone: false, undoneTurns: 0, restored: [] }),
      undoFilePlan: () => [],
      requestUndoChoice: async () => 'chat',
      defaultUndoWithFiles: false,
      compact: async () => ({ note: '' }),
      update: async () => ({ message: '' }),
      statusReport: () => '',
    };
    await undo.run(ctx, '');
    expect(touched).toContain('[nothing to undo]');
  });
});
