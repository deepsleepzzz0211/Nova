import Anthropic from '@anthropic-ai/sdk';
import type { Message, StreamChunk, ChatOptions } from '../types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from '../provider.js';
import { withSystemPrompt } from '../messages.js';

/** Anthropic cache_control marker for prompt caching breakpoints. */
const CACHE_CONTROL = { type: 'ephemeral' as const };

/**
 * LLM provider backed by the Anthropic API.
 *
 * Prompt caching (pi-style cacheControlFormat "anthropic"):
 *  - the system prompt carries a cache_control breakpoint
 *  - the last tool definition carries a cache_control breakpoint
 *  - usage events report cache read / cache write tokens
 *
 * Mid-history system messages (e.g. injected skills) are converted to user
 * messages prefixed with "[context]" so the conversation stays append-only
 * and the cached prefix remains valid.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  readonly name = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    maxContextLength: 200000,
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
  };

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const fullMessages = withSystemPrompt(messages, options.systemPrompt);

      // First system message → system param (with cache breakpoint)
      const systemMessage = fullMessages.find(m => m.role === 'system');

      // Remaining messages; later system messages become user-context messages
      const conversationMessages = fullMessages
        .filter(m => m.role !== 'system' || m !== systemMessage)
        .map(m => {
          if (m.role === 'system') {
            return { role: 'user' as const, content: `[context] ${m.content}` };
          }
          return { role: m.role as 'user' | 'assistant', content: m.content || '' };
        });

      const tools = options.tools as Array<Record<string, unknown>> | undefined;
      const cachedTools = tools && tools.length > 0
        ? tools.map((tool, i) =>
            i === tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool,
          )
        : undefined;

      const stream = this.client.messages.stream({
        model: options.model,
        max_tokens: options.maxTokens || 4096,
        system: systemMessage
          ? [{ type: 'text' as const, text: systemMessage.content, cache_control: CACHE_CONTROL }]
          : undefined,
        messages: conversationMessages,
        tools: cachedTools as never,
      });

      // Track the current tool-use block so input_json_delta chunks carry the id
      let currentToolId: string | null = null;
      let currentToolName: string | null = null;

      // Accumulated usage; emitted once at message_stop as a single chunk
      let usageInput = 0;
      let usageCached = 0;
      let usageWrite = 0;
      let usageOutput = 0;

      for await (const event of stream) {
        if (event.type === 'message_start') {
          const usage = event.message.usage;
          usageInput =
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          usageCached = usage.cache_read_input_tokens ?? 0;
          usageWrite = usage.cache_creation_input_tokens ?? 0;
          usageOutput = usage.output_tokens;
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            yield { type: 'tool_call_start', id: currentToolId, name: currentToolName };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', content: event.delta.text };
          } else if (event.delta.type === 'input_json_delta' && currentToolId) {
            yield { type: 'tool_call_delta', id: currentToolId, arguments: event.delta.partial_json };
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolId) {
            yield { type: 'tool_call_end', id: currentToolId };
            currentToolId = null;
            currentToolName = null;
          }
        } else if (event.type === 'message_delta' && event.usage?.output_tokens !== undefined) {
          // Final output token count for this response
          usageOutput = event.usage.output_tokens;
        } else if (event.type === 'message_stop') {
          yield {
            type: 'usage',
            inputTokens: usageInput,
            outputTokens: usageOutput,
            cachedInputTokens: usageCached,
            cacheWriteTokens: usageWrite,
          };
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}
