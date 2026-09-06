import type { LLMProvider } from '../llm/provider.js';
import type { StreamChunk, Message, ToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import { buildSystemPrompt } from './prompt.js';

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  /** Single execution path for all tool invocations. */
  toolExecutionPipeline: ToolExecutionPipeline;
  config: { maxToolRounds: number; model: string };
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
  private readonly onToken: (token: string) => void;
  private readonly onToolCall: (call: ToolCall) => void;
  private readonly onToolResult: (result: ToolResult) => void;
  private readonly onPermissionRequest: (call: ToolCall) => Promise<boolean>;
  private readonly messages: Message[] = [];

  constructor(options: AgentLoopConfig) {
    this.llm = options.llm;
    this.toolRegistry = options.toolRegistry;
    this.toolExecutionPipeline = options.toolExecutionPipeline;
    this.maxToolRounds = options.config.maxToolRounds;
    this.model = options.config.model;
    this.onToken = options.onToken;
    this.onToolCall = options.onToolCall;
    this.onToolResult = options.onToolResult;
    this.onPermissionRequest = options.onPermissionRequest;
  }

  async processUserInput(input: string): Promise<void> {
    this.messages.push({ role: 'user', content: input });

    const systemPrompt = buildSystemPrompt(
      this.toolRegistry.getAll(),
      [],
    );

    const tools = this.toolRegistry.toToolDefinitions();

    for (let toolRound = 0; toolRound <= this.maxToolRounds; toolRound++) {
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
        this.messages.push({
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
            this.messages.push({
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
      this.messages.push({ role: 'assistant', content: textContent });
      return;
    }

    // Exceeded maxToolRounds — append what we have and stop
    this.messages.push({ role: 'assistant', content: '' });
  }
}
