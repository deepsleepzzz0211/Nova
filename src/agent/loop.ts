import type { LLMProvider } from '../llm/provider.js';
import type { StreamChunk, Message, ToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionStore } from './session.js';
import { Compactor } from './compaction.js';
import { ContextManager } from './context.js';
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
  /** Token budget for the conversation. */
  maxTokens: number;
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
      ? new ContextManager({ model: options.config.model, maxTokens: options.context.maxTokens })
      : null;
    this.contextStrategy = options.context?.strategy ?? null;
    this.compactor = options.context?.strategy === 'compact'
      ? new Compactor(options.llm, options.config.model)
      : null;
    this.session = options.session ?? null;
    this.skills = options.skills ?? null;
    this.maxActiveSkills = options.maxActiveSkills ?? 2;
    this.promptOptions = options.promptOptions ?? {};
    this.onUsage = options.onUsage;
    this.thinkingLevel = options.thinkingLevel;
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

    let after: Message[];
    if (this.contextStrategy === 'compact' && this.compactor) {
      const compacted = await this.compactor.compact(this.messages);
      if (compacted === null) return; // fail-open: keep as-is
      after = compacted;
    } else {
      after = this.contextManager.truncate(this.messages);
    }

    const afterTokens = this.contextManager.countTokens(after);
    this.messages = after;
    this.onCompaction?.({ strategy: this.contextStrategy, beforeTokens, afterTokens });
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
          abortSignal: new AbortController().signal,
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
      after = await this.compactor.compact(this.messages);
    }
    if (after === null) {
      // Manual truncate target: half the trigger budget (aggressive cleanup)
      after = this.contextManager.truncateToTokens(
        this.messages,
        Math.floor(this.contextManager.triggerTokens / 2),
      );
    }

    if (after.length === this.messages.length) {
      return { compacted: false, strategy: this.contextStrategy, beforeTokens };
    }

    const afterTokens = this.contextManager.countTokens(after);
    this.messages = after;
    this.onCompaction?.({ strategy: this.contextStrategy, beforeTokens, afterTokens });
    return { compacted: true, strategy: this.contextStrategy, beforeTokens, afterTokens };
  }
}
