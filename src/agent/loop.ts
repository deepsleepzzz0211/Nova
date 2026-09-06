import type { LLMProvider } from '../llm/provider.js';
import type { StreamChunk, Message, ToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionStore } from './session.js';
import { Compactor } from './compaction.js';
import { ContextManager } from './context.js';
import { buildSystemPrompt } from './prompt.js';

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
  /** Notified after a compaction/truncation pass. */
  onCompaction?: (info: { strategy: 'truncate' | 'compact'; beforeTokens: number; afterTokens: number }) => void;
  onToken: (token: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onPermissionRequest: (call: ToolCall) => Promise<boolean>;
}

/** Core orchestration loop that manages LLM conversation with tool execution. */
export class AgentLoop {
  private readonly llm: LLMProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutionPipeline: ToolExecutionPipeline;
  private readonly maxToolRounds: number;
  private readonly model: string;
  private readonly contextManager: ContextManager | null;
  private readonly contextStrategy: LoopContextConfig['strategy'] | null;
  private readonly compactor: Compactor | null;
  private readonly session: SessionStore | null;
  private readonly onCompaction: AgentLoopConfig['onCompaction'];
  private readonly onToken: (token: string) => void;
  private readonly onToolCall: (call: ToolCall) => void;
  private readonly onToolResult: (result: ToolResult) => void;
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

  async processUserInput(input: string): Promise<void> {
    this.pushMessage({ role: 'user', content: input });

    const systemPrompt = buildSystemPrompt(
      this.toolRegistry.getAll(),
      [],
    );

    const tools = this.toolRegistry.toToolDefinitions();

    for (let toolRound = 0; toolRound <= this.maxToolRounds; toolRound++) {
      await this.prepareContext();

      const toolCalls = new Map<string, { name: string; args: string }>();
      let textContent = '';

      try {
        const stream = this.llm.chat(this.messages, {
          model: this.model,
          tools,
          systemPrompt,
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
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onToken(`[Error: ${msg}]`);
        return;
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

        // Execute each tool call through the single execution pipeline.
        // The pipeline owns the permission policy + user confirmation;
        // the loop only supplies the confirmation callback.
        for (const call of callArray) {
          const pushToolMessage = (result: ToolResult): void => {
            this.onToolResult(result);
            this.pushMessage({
              role: 'tool',
              tool_call_id: call.id,
              content: result.content,
              is_error: result.isError,
            });
          };

          const tool = this.toolRegistry.get(call.function.name);
          if (!tool) {
            pushToolMessage({
              content: `Tool "${call.function.name}" not found.`,
              isError: true,
            });
            continue;
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
            pushToolMessage(result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            pushToolMessage({ content: msg, isError: true });
          }
        }

        // Continue to next round — call LLM again with tool results
        continue;
      }

      // Text-only response — append and done
      this.pushMessage({ role: 'assistant', content: textContent });
      return;
    }

    // Exceeded maxToolRounds — append what we have and stop
    this.messages.push({ role: 'assistant', content: '' });
  }
}
