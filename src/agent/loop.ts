import type { LLMProvider } from '../llm/provider.js';
import type { StreamChunk, Message, ToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionStore } from './session.js';
import { Compactor } from './compaction.js';
import { ContextManager } from './context.js';
import { isContextOverflowError } from '../llm/errors.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BuildPromptOptions } from './prompt.js';
import { buildSystemPrompt } from './prompt.js';
import type { TurnUsage } from '../cache/prompt-cache-metrics.js';
import type { ThinkingLevel } from '../llm/compat.js';

/** Result of a single user-input turn. */
export interface AgentTurnResult {
  /** Final assistant text (empty when the turn ended without text). */
  text: string;
  /** Number of LLM rounds consumed. */
  rounds: number;
}

/** Context management configuration. */
export interface LoopContextConfig {
  /** Model context window size. */
  maxTokens: number;
  /** Tokens reserved for the LLM response (trigger = window − reserve). Default 16384. */
  reserveTokens?: number;
  /** Recent tokens kept verbatim during compaction. Default 20000. */
  keepRecentTokens?: number;
  /** What to do when the budget is approached: drop old messages or summarize. */
  strategy: 'truncate' | 'compact';
}

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  /** Single execution path for all tool invocations. */
  toolExecutionPipeline: ToolExecutionPipeline;
  config: { maxToolRounds: number; model: string };
  /** Optional context window management. */
  context?: LoopContextConfig;
  /** Optional JSONL session persistence. */
  session?: SessionStore;
  /** Optional skill registry for progressive disclosure. */
  skills?: SkillRegistry;
  /** Extra system prompt parts (environment facts, project instructions, custom). */
  promptOptions?: BuildPromptOptions;
  /** Maximum matched skills whose full body is injected per turn. Default 2. */
  maxActiveSkills?: number;
  /** Notified after a compaction/truncation pass. */
  onCompaction?: (info: { strategy: 'truncate' | 'compact'; beforeTokens: number; afterTokens: number }) => void;
  /** Notified once per turn with aggregated provider usage (cache metrics). */
  onUsage?: (usage: TurnUsage) => void;
  /** Unified thinking level forwarded to every chat call. */
  thinkingLevel?: ThinkingLevel;
  /** Cancellation signal: aborts in-flight tool execution (and future rounds). */
  abortSignal?: AbortSignal;
  onToken: (token: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult, callId?: string) => void;
  onPermissionRequest: (call: ToolCall) => Promise<boolean>;
}

/** Core orchestration loop that manages LLM conversation with tool execution. */
export class AgentLoop {
  private llm: LLMProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutionPipeline: ToolExecutionPipeline;
  private readonly maxToolRounds: number;
  private model: string;
  private readonly contextManager: ContextManager | null;
  private readonly contextStrategy: LoopContextConfig['strategy'] | null;
  private readonly compactor: Compactor | null;
  private readonly session: SessionStore | null;
  private readonly skills: SkillRegistry | null;
  private readonly maxActiveSkills: number;
  private readonly promptOptions: BuildPromptOptions;
  private readonly onCompaction: AgentLoopConfig['onCompaction'];
  private readonly onUsage: AgentLoopConfig['onUsage'];
  private readonly thinkingLevel?: ThinkingLevel;
  /**
   * Base system prompt, frozen at construction.
   *
   * Cache philosophy (pi-style): the system prompt must stay byte-identical
   * across the whole session so the provider prompt-cache prefix survives.
   * Turn-scoped content (skills) travels as append-only messages instead.
   */
  private readonly frozenSystemPrompt: string;
  private readonly abortSignal?: AbortSignal;
  private readonly onToken: (token: string) => void;
  private readonly onToolCall: (call: ToolCall) => void;
  private readonly onToolResult: (result: ToolResult, callId?: string) => void;
  private readonly onPermissionRequest: (call: ToolCall) => Promise<boolean>;
  private messages: Message[] = [];

  constructor(options: AgentLoopConfig) {
    this.llm = options.llm;
    this.toolRegistry = options.toolRegistry;
    this.toolExecutionPipeline = options.toolExecutionPipeline;
    this.maxToolRounds = options.config.maxToolRounds;
    this.model = options.config.model;
    this.contextManager = options.context
      ? new ContextManager({
          model: options.config.model,
          maxTokens: options.context.maxTokens,
          reserveTokens: options.context.reserveTokens,
        })
      : null;
    this.contextStrategy = options.context?.strategy ?? null;
    this.compactor = options.context?.strategy === 'compact' && options.context
      ? new Compactor(options.llm, options.config.model, {
          keepRecentTokens: options.context.keepRecentTokens,
          triggerTokens: this.contextManager?.triggerTokens,
        })
      : null;
    this.session = options.session ?? null;
    this.skills = options.skills ?? null;
    this.maxActiveSkills = options.maxActiveSkills ?? 2;
    this.promptOptions = options.promptOptions ?? {};
    this.onUsage = options.onUsage;
    this.thinkingLevel = options.thinkingLevel;
    this.abortSignal = options.abortSignal;
    this.frozenSystemPrompt = buildSystemPrompt(this.toolRegistry.getAll(), options.skills?.findAll() ?? [], {
      ...this.promptOptions,
    });
    this.onCompaction = options.onCompaction;
    this.onToken = options.onToken;
    this.onToolCall = options.onToolCall;
    this.onToolResult = options.onToolResult;
    this.onPermissionRequest = options.onPermissionRequest;
  }

  /** Seed the conversation from a previous session (resume). */
  loadMessages(history: Message[]): void {
    this.messages = [...history];
  }

  /** Switch the active model (per-request ChatOptions value). */
  setModel(model: string): void {
    this.model = model;
  }

  /** Switch the LLM provider (e.g. after a catalog-driven /model switch). */
  setProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  /** Append a message to the conversation and the session log. */
  private pushMessage(message: Message): void {
    this.messages.push(message);
    void this.session?.append(message);
  }

  /** Run a truncate/compact pass when the conversation approaches the budget. */
  private async prepareContext(): Promise<void> {
    if (!this.contextManager || !this.contextStrategy) return;

    const beforeTokens = this.contextManager.countTokens(this.messages);
    if (!this.contextManager.isNearLimit(beforeTokens)) return;

    // Fallback chain: compact → truncate. A failed summary must still
    // shrink the context; fail-open here would hit the window on the
    // very next round. "Nothing to summarize" is NOT a failure — keep
    // the messages as-is (e.g. a single huge user message). 
    let after: Message[] | null = null;
    let applied: LoopContextConfig['strategy'] = this.contextStrategy;
    if (this.contextStrategy === 'compact' && this.compactor) {
      const result = await this.compactor.compact(this.messages);
      if (result === null) {
        applied = 'truncate';
      } else if (result.method !== 'none') {
        after = result.messages; // summary or placeholder pass
      } else {
        return; // nothing to compact — no compaction possible
      }
    }
    if (after === null) {
      after = this.contextManager.truncate(this.messages);
    }

    const afterTokens = this.contextManager.countTokens(after);
    this.messages = after;
    this.persistCompaction(after);
    this.onCompaction?.({ strategy: applied, beforeTokens, afterTokens });
  }

  /** Persist a compaction checkpoint so --resume replays the slim state. */
  private persistCompaction(messages: Message[]): void {
    void this.session?.appendCompaction(messages);
  }

  /**
   * Undo the last N conversation turns (a turn = one user message and
   * everything after it until the next user message). Conversation-only:
   * file changes made by tools are NOT reverted (use git for those).
   * Persistence stays append-only: the post-undo state is written as a
   * checkpoint, which --resume replays as the truncated history.
   * N is clamped to the number of available turns.
   */
  undoTurns(n = 1): { undone: boolean; undoneTurns: number } {
    const userIdxs: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') userIdxs.push(i);
    }
    if (userIdxs.length === 0 || n < 1) {
      return { undone: false, undoneTurns: 0 };
    }

    const undoneTurns = Math.min(n, userIdxs.length);
    const cut = undoneTurns === userIdxs.length ? 0 : userIdxs[userIdxs.length - undoneTurns];
    const after = this.messages.slice(0, cut);
    this.messages = after;
    this.persistCompaction(after); // append-only checkpoint; replay truncates
    return { undone: true, undoneTurns };
  }

  /**
   * Load full bodies of skills matching the user input as an append-only
   * system message. The frozen system prompt itself is never mutated, so
   * the provider prompt-cache prefix stays valid.
   */
  private async injectSkills(userInput: string): Promise<void> {
    if (!this.skills) return;

    const matched = this.skills.findByKeywords(userInput).slice(0, this.maxActiveSkills);
    if (matched.length === 0) return;

    const sections: string[] = [];
    for (const meta of matched) {
      try {
        sections.push(await this.skills.load(meta));
      } catch {
        // Skip skills that cannot be read
      }
    }
    if (sections.length === 0) return;

    this.pushMessage({
      role: 'system',
      content: `## Active Skills\n${sections.join('\n\n---\n\n')}`,
    });
  }

  async processUserInput(input: string): Promise<AgentTurnResult> {
    return this.runTurn(input);
  }

  /** Run a turn with an explicit system prompt (used by subagents). */
  async processUserInputWithSystemPrompt(input: string, systemPrompt: string): Promise<AgentTurnResult> {
    return this.runTurn(input, systemPrompt);
  }

  /** Result of a single user-input turn. */
  private async runTurn(input: string, systemPromptOverride?: string): Promise<AgentTurnResult> {
    this.pushMessage({ role: 'user', content: input });

    if (!systemPromptOverride) {
      await this.injectSkills(input);
    }
    const systemPrompt = systemPromptOverride ?? this.frozenSystemPrompt;
    let rounds = 0;
    let finalText = '';
    const turnUsage: Required<Pick<TurnUsage, 'inputTokens' | 'outputTokens'>> & Partial<TurnUsage> = {
      inputTokens: 0,
      outputTokens: 0,
    };

    const tools = this.toolRegistry.toToolDefinitions();

    // Reactive overflow recovery (context-compaction ticket 04): token estimates can never be
    // exact, so when the provider rejects the request for exceeding the
    // context window we compact once (with the truncate fallback) and retry
    // the same round exactly once. A second overflow surfaces as a normal
    // error — no compaction loop.
    let overflowRetried = false;

    for (let toolRound = 0; toolRound <= this.maxToolRounds; toolRound++) {
      await this.prepareContext();
      rounds++;

      const toolCalls = new Map<string, { name: string; args: string }>();
      let textContent = '';

      try {
        const stream = this.llm.chat(this.messages, {
          model: this.model,
          tools,
          systemPrompt,
          thinkingLevel: this.thinkingLevel,
        });

        for await (const chunk of stream) {
          switch (chunk.type) {
            case 'text_delta':
              textContent += chunk.content;
              this.onToken(chunk.content);
              break;
            case 'tool_call_start':
              toolCalls.set(chunk.id, { name: chunk.name, args: '' });
              break;
            case 'tool_call_delta': {
              const tc = toolCalls.get(chunk.id);
              if (tc) tc.args += chunk.arguments;
              break;
            }
            case 'tool_call_end': {
              // no-op; tool call is complete in the map
              break;
            }
            case 'error':
              this.onToken(`[Error: ${chunk.error}]`);
              break;
            case 'usage':
              turnUsage.inputTokens += chunk.inputTokens;
              turnUsage.outputTokens += chunk.outputTokens;
              turnUsage.cachedInputTokens = (turnUsage.cachedInputTokens ?? 0) + (chunk.cachedInputTokens ?? 0);
              turnUsage.cacheWriteTokens = (turnUsage.cacheWriteTokens ?? 0) + (chunk.cacheWriteTokens ?? 0);
              break;
          }
        }
      } catch (err: unknown) {
        if (isContextOverflowError(err) && !overflowRetried) {
          const compacted = await this.compactNow();
          if (compacted.compacted) {
            overflowRetried = true;
            toolRound--; // retry the same round after compaction
            rounds--; // the retry is the same round, not a new one
            continue;
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.onToken(`[Error: ${msg}]`);
        this.emitUsage(turnUsage);
        return { text: finalText, rounds };
      }

      // If the LLM returned tool calls, process them
      if (toolCalls.size > 0) {
        const callArray: ToolCall[] = [];
        for (const [id, tc] of toolCalls) {
          const call: ToolCall = {
            id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          };
          callArray.push(call);
          this.onToolCall(call);
        }

        // Append assistant message with tool_calls
        this.pushMessage({
          role: 'assistant',
          content: textContent || null,
          tool_calls: callArray,
        });

        // Execute all tool calls of the round concurrently (mainstream
        // pattern); results are appended to the conversation in call order.
        const settled = await Promise.all(
          callArray.map(async (call) => ({ call, result: await this.executeToolCall(call) })),
        );
        for (const { call, result } of settled) {
          this.pushMessage({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // Cancelled mid-run: stop without another LLM round
        if (this.abortSignal?.aborted) {
          this.pushMessage({ role: 'assistant', content: '' });
          this.emitUsage(turnUsage);
          return { text: '', rounds };
        }

        // Continue to next round — call LLM again with tool results
        continue;
      }

      // Text-only response — append and done
      this.pushMessage({ role: 'assistant', content: textContent });
      finalText = textContent;
      this.emitUsage(turnUsage);
      return { text: finalText, rounds };
    }

    // Exceeded maxToolRounds — append what we have and stop
    this.pushMessage({ role: 'assistant', content: '' });
    this.emitUsage(turnUsage);
    return { text: '', rounds };
  }

  /** Report aggregated per-turn usage to the cache metrics listener. */
  private emitUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    this.onUsage?.({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  }

  /** Execute one tool call through the pipeline and notify the UI. */
  private async executeToolCall(call: ToolCall): Promise<ToolResult> {
    if (this.abortSignal?.aborted) {
      const result: ToolResult = { content: 'Aborted.', isError: true };
      this.onToolResult(result, call.id);
      return result;
    }
    const tool = this.toolRegistry.get(call.function.name);
    if (!tool) {
      const result: ToolResult = {
        content: `Tool "${call.function.name}" not found.`,
        isError: true,
      };
      this.onToolResult(result, call.id);
      return result;
    }

    try {
      const params = JSON.parse(call.function.arguments) as Record<string, unknown>;
      const result = await this.toolExecutionPipeline.execute(
        tool,
        params,
        {
          workingDirectory: process.cwd(),
          abortSignal: this.abortSignal ?? new AbortController().signal,
        },
        { confirm: () => this.onPermissionRequest(call) },
      );
      this.onToolResult(result, call.id);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const result: ToolResult = { content: msg, isError: true };
      this.onToolResult(result, call.id);
      return result;
    }
  }

  /** Current conversation history (introspection/testing). */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Force a compaction/truncation pass regardless of the token trigger.
   * Used by the /compact command.
   */
  async compactNow(): Promise<{
    compacted: boolean;
    strategy?: 'truncate' | 'compact';
    beforeTokens?: number;
    afterTokens?: number;
  }> {
    if (!this.contextManager || !this.contextStrategy) {
      return { compacted: false };
    }

    const beforeTokens = this.contextManager.countTokens(this.messages);

    let after: Message[] | null = null;
    if (this.compactor) {
      const result = await this.compactor.compact(this.messages);
      if (result === null) {
        // Summary failed → degrade to an aggressive truncate
        after = this.contextManager.truncateToTokens(
          this.messages,
          Math.floor(this.contextManager.triggerTokens / 2),
        );
      } else if (result.method !== 'none') {
        after = result.messages; // summary or placeholder pass
      } else {
        // Nothing to summarize (e.g. all user messages): nothing to do
        return { compacted: false, strategy: this.contextStrategy, beforeTokens };
      }
    }
    if (after === null) {
      // Manual truncate target: half the trigger budget (aggressive cleanup)
      after = this.contextManager.truncateToTokens(
        this.messages,
        Math.floor(this.contextManager.triggerTokens / 2),
      );
    }

    const afterTokens = this.contextManager.countTokens(after);
    // Compaction is meaningful only when it actually shrank the context
    // (the summary can outweigh toy-size summarized content).
    if (afterTokens >= beforeTokens) {
      return { compacted: false, strategy: this.contextStrategy, beforeTokens };
    }
    this.messages = after;
    this.persistCompaction(after);
    this.onCompaction?.({ strategy: this.contextStrategy, beforeTokens, afterTokens });
    return { compacted: true, strategy: this.contextStrategy, beforeTokens, afterTokens };
  }
}
