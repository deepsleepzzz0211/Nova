import type { Message, StreamChunk, ChatOptions } from '../types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from '../provider.js';
import { AnthropicMessagesAdapter } from '../adapters/anthropic-messages.js';

/**
 * LLM provider backed by the Anthropic Messages wire protocol.
 * Thin shell delegating to the anthropic-messages adapter
 * (prompt caching via cache_control breakpoints included).
 */
export class AnthropicProvider implements LLMProvider {
  private readonly adapter: AnthropicMessagesAdapter;
  readonly name = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    maxContextLength: 200000,
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
  };

  constructor(config: ProviderConfig) {
    this.adapter = new AnthropicMessagesAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model ?? 'claude-3-5-sonnet-20241022',
      compat: { supportsDeveloperRole: false, streamUsage: false },
    });
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    yield* this.adapter.chat(messages, options);
  }
}
