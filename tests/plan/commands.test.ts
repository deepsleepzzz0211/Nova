import { describe, it, expect, vi } from 'vitest';
import {
  SLASH_COMMANDS,
  findCommand,
  type SlashCommandContext,
} from '../../src/tui/commands.js';

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    appendUserMessage: vi.fn(),
    appendSystemMessage: vi.fn(),
    replaceConversation: vi.fn(),
    listModels: vi.fn(() => 'model listing'),
    switchModel: vi.fn(() => ({ ok: true, message: 'switched', model: 'm2' })),
    undoTurns: vi.fn(() => ({ undone: true, undoneTurns: 1, restored: [] })),
    undoFilePlan: vi.fn(() => [] as string[]),
    requestUndoChoice: vi.fn(async () => 'chat' as const),
    defaultUndoWithFiles: false,
    compact: vi.fn(async () => ({ compacted: true, note: 'compacted' })),
    update: vi.fn(async () => ({ message: 'update ok' })),
    statusReport: vi.fn(() => 'status report'),
    userCommands: vi.fn((): import('../../src/commands/user-commands.js').UserCommand[] => []),
    ...overrides,
  };
}

describe('slash commands registry (tui-refactor 15)', () => {
  it('declares the built-in commands with descriptions', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(['model', 'undo', 'compact', 'update', 'status', 'help']);
    for (const c of SLASH_COMMANDS) expect(c.description.length).toBeGreaterThan(0);
  });

  describe('findCommand', () => {
    it('parses a bare command', () => {
      expect(findCommand('/model')).toEqual({ command: SLASH_COMMANDS[0], args: '' });
    });

    it('parses a command with arguments', () => {
      const found = findCommand('/model openai/gpt-5');
      expect(found?.command?.name).toBe('model');
      expect(found?.args).toBe('openai/gpt-5');
    });

    it('parses numeric arguments for undo', () => {
      const found = findCommand('/undo 3');
      expect(found?.command?.name).toBe('undo');
      expect(found?.args).toBe('3');
    });

    it('returns null for non-commands and unknown commands', () => {
      expect(findCommand('hello')).toBeNull();
      expect(findCommand('/nope')).toBeNull();
      expect(findCommand('  ')).toBeNull();
    });

    it('does not treat a mid-text slash as a command', () => {
      expect(findCommand('see /model docs')).toBeNull();
    });
  });

  describe('handlers', () => {
    it('/model with no args lists models', async () => {
      const ctx = makeCtx();
      await findCommand('/model')!!.command!.run(ctx, '');
      expect(ctx.listModels).toHaveBeenCalled();
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith('model listing');
    });

    it('/model with a spec switches and reports', async () => {
      const ctx = makeCtx();
      await findCommand('/model openai/gpt-5')!!.command!.run(ctx, 'openai/gpt-5');
      expect(ctx.switchModel).toHaveBeenCalledWith('openai/gpt-5');
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith('switched');
    });

    it('/undo rebuilds the conversation and reports', async () => {
      const restored = [{ role: 'user' as const, content: 'hi' }];
      const ctx = makeCtx({
        undoTurns: vi.fn(() => ({ undone: true, undoneTurns: 2, restored })),
      });
      await findCommand('/undo 2')!!.command!.run(ctx, '2');
      expect(ctx.undoTurns).toHaveBeenCalledWith(2, { withFiles: false });
      expect(ctx.replaceConversation).toHaveBeenCalledWith(restored);
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith(expect.stringContaining('undone 2 turn'));
    });

    it('/undo defaults to one turn and reports nothing to undo', async () => {
      const ctx = makeCtx({ undoTurns: vi.fn(() => ({ undone: false, undoneTurns: 0, restored: [] })) });
      await findCommand('/undo')!!.command!.run(ctx, '');
      expect(ctx.undoTurns).toHaveBeenCalledWith(1, { withFiles: false });
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith(expect.stringContaining('nothing to undo'));
    });

    it('/compact reports the compaction outcome', async () => {
      const ctx = makeCtx();
      await findCommand('/compact')!!.command!.run(ctx, '');
      expect(ctx.compact).toHaveBeenCalled();
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith(expect.stringContaining('compacted'));
    });

    it('/update runs the update flow', async () => {
      const ctx = makeCtx();
      await findCommand('/update')!!.command!.run(ctx, '');
      expect(ctx.update).toHaveBeenCalled();
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith('update ok');
    });

    it('/help lists built-in and custom commands in two groups', async () => {
      const ctx = makeCtx({
        userCommands: vi.fn(() => [
          { name: 'summarize-changes', description: 'summarize a path', argumentHint: '<path>', template: 't' },
        ] as import('../../src/commands/user-commands.js').UserCommand[]),
      });
      await findCommand('/help')!!.command!.run(ctx, '');
      const out = String((ctx.appendSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(out).toContain('/model');
      expect(out).toContain('/summarize-changes <path> — summarize a path');
      expect(out).toMatch(/Custom commands/);
    });

    it('/help omits the custom group when there are no user commands', async () => {
      const ctx = makeCtx();
      await findCommand('/help')!!.command!.run(ctx, '');
      const out = String((ctx.appendSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(out).toContain('/status');
      expect(out).not.toMatch(/Custom commands/);
    });

    it('/status appends the composed status report', async () => {
      const ctx = makeCtx();
      await findCommand('/status')!!.command!.run(ctx, '');
      expect(ctx.statusReport).toHaveBeenCalled();
      expect(ctx.appendSystemMessage).toHaveBeenCalledWith('status report');
    });
  });
});
