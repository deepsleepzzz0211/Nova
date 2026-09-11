import type { AgentLoop } from '../agent/loop.js';
import type { ModelCost } from '../llm/catalog.js';
import type {
  DisplayMessage,
  DisplayModelInfo,
  RestoredMessage,
} from './display-types.js';
import type { SlashCommandContext } from './commands.js';

/** Dependencies the command context adapts onto the loop + UI state. */
export interface CommandContextDeps {
  /** The live agent loop (never null once constructed). */
  loop: AgentLoop;
  /** Model listing text for /model with no arguments. */
  listModels?: () => string;
  /** Apply a /model <spec> switch (returns the loop provider + metadata). */
  resolveSwitch?: (spec: string) => {
    ok: boolean;
    message?: string;
    llm?: import('../llm/provider.js').LLMProvider;
    model?: string;
    contextWindow?: number;
    providerName?: string;
    cost?: ModelCost;
  };

  /** React state setter for the displayed conversation. */
  updateMessages: (updater: (prev: DisplayMessage[]) => DisplayMessage[]) => void;
  /** React state setter for the model info shown in the footer. */
  setModelInfo: (info: DisplayModelInfo) => void;
  /** Run the global update flow. */
  runUpdate: () => Promise<{ message: string }>;
}

/** UI-only conversation entries (drops tool/system rows for /undo restore). */
export function restoredConversation(
  loop: Pick<AgentLoop, 'getMessages'>,
): RestoredMessage[] {
  return loop
    .getMessages()
    .filter((msg): msg is { role: 'user' | 'assistant'; content: string } =>
      (msg.role === 'user' || msg.role === 'assistant') &&
      typeof msg.content === 'string' &&
      msg.content.length > 0,
    )
    .map((msg) => ({ role: msg.role, content: msg.content }));
}

/**
 * Build the SlashCommandContext the registry handlers receive
 * (tui-refactor ticket 15 review fix): the adapter lives here instead of
 * inline in the hook, so sendMessage stays small and this is unit-testable
 * with a fake loop.
 */
export function createCommandContext(deps: CommandContextDeps): SlashCommandContext {
  return {
    appendUserMessage: (text) =>
      deps.updateMessages((prev) => [...prev, { role: 'user', content: text }]),
    appendSystemMessage: (text) =>
      deps.updateMessages((prev) => [...prev, { role: 'system', content: text }]),
    replaceConversation: (messages) =>
      deps.updateMessages(() => messages.map((m) => ({ role: m.role, content: m.content }))),
    listModels: () => deps.listModels?.() ?? 'No model catalog available.',
    switchModel: (spec) => {
      const result = deps.resolveSwitch?.(spec);
      if (result?.ok && result.llm !== undefined && result.model !== undefined) {
        deps.loop.setProvider(result.llm);
        deps.loop.setModel(result.model);
        deps.setModelInfo({
          model: result.model,
          contextWindow: result.contextWindow,
          providerName: result.providerName ?? '',
          cost: result.cost,
        });
      }
      return { message: result?.message ?? 'Model switching unavailable.' };
    },
    undoTurns: (n) => {
      const result = deps.loop.undoTurns(n);
      return {
        undone: result.undone,
        undoneTurns: result.undoneTurns,
        restored: result.undone ? restoredConversation(deps.loop) : [],
      };
    },
    compact: async () => {
      const result = await deps.loop.compactNow();
      // Successful compactions are announced by the loop's onCompaction
      // callback; a note here would duplicate it.
      return {
        note: result.compacted ? '' : '[nothing to compact — context is small]',
      };
    },
    update: async () => deps.runUpdate(),
  };
}
