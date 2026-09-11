/**
 * Slash-command registry (tui-refactor ticket 15): ONE declaration per
 * command — name, description, argument handling and the handler itself —
 * consumed by the InputBar completion list and the useAgent dispatch.
 * Handlers receive an injected context of UI callbacks so this module
 * needs no React/loop imports.
 */

/** UI callbacks a command may use. Implemented by useAgent. */
export interface SlashCommandContext {
  /** Append a user-echo message (the dispatcher echoes, not handlers). */
  appendUserMessage(text: string): void;
  /** Append a system/informational message. */
  appendSystemMessage(text: string): void;
  /** Replace the whole displayed conversation (e.g. after /undo). */
  replaceConversation(messages: Array<{ role: 'user' | 'assistant'; content: string }>): void;
  /** Model listing text for /model with no arguments. */
  listModels(): string;
  /** Apply a model switch; returns the user-facing result. */
  switchModel(spec: string): { message: string };
  /** Revert the last n conversation turns. */
  undoTurns(n: number): {
    undone: boolean;
    undoneTurns: number;
    restored: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  /** Force a context compaction pass (empty note = loop already announced). */
  compact(): Promise<{ note: string }>;
  /** Run the global update flow. */
  update(): Promise<{ message: string }>;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Whether the command accepts an argument (completion adds a space). */
  acceptsArgs?: boolean;
  /** Echo the submitted command line as a user message (default false). */
  echoesInput?: boolean;
  run(ctx: SlashCommandContext, args: string): void | Promise<void>;
}

/** Built-in slash commands — the single source for completion + dispatch. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'model',
    description: 'list or switch models',
    acceptsArgs: true,
    async run(ctx, args) {
      const spec = args.trim();
      if (spec === '') {
        ctx.appendSystemMessage(ctx.listModels());
        return;
      }
      const result = ctx.switchModel(spec);
      ctx.appendSystemMessage(result.message);
    },
  },
  {
    name: 'undo',
    description: 'revert the last n conversation turns',
    acceptsArgs: true,
    echoesInput: true,
    async run(ctx, args) {
      const n = Number.parseInt(args.trim(), 10);
      const turns = Number.isFinite(n) && n >= 1 ? n : 1;
      const result = ctx.undoTurns(turns);
      if (result.undone) {
        ctx.replaceConversation(result.restored);
        ctx.appendSystemMessage(
          `[undone ${result.undoneTurns} turn(s) — conversation reverted; code changes are NOT reverted, check git status]`,
        );
      } else {
        ctx.appendSystemMessage('[nothing to undo]');
      }
    },
  },
  {
    name: 'compact',
    description: 'force a context compaction pass',
    echoesInput: true,
    async run(ctx) {
      const result = await ctx.compact();
      // The loop announces successful compactions itself (onCompaction);
      // only a no-op needs a message from here (review fix: no duplicate).
      if (result.note !== '') ctx.appendSystemMessage(result.note);
    },
  },
  {
    name: 'update',
    description: 'update nova globally (takes effect on restart)',
    async run(ctx) {
      ctx.appendSystemMessage('checking for updates…');
      const result = await ctx.update();
      ctx.appendSystemMessage(result.message);
    },
  },
];

export interface FoundCommand {
  command: SlashCommand;
  args: string;
}

/**
 * Parse a submitted line into a command + raw arguments, or null when the
 * line is not a known command. Only a leading slash counts.
 */
export function findCommand(text: string): FoundCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const name = space === -1 ? body : body.slice(0, space);
  const args = space === -1 ? '' : body.slice(space + 1).trim();
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  return command === undefined ? null : { command, args };
}


