import type { Message, StreamChunk, ChatOptions } from './types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from './provider.js';
import type { CompatFlags } from './compat.js';
import { normalizeCompat } from './compat.js';
import { OpenAICompletionsAdapter } from './adapters/openai-completions.js';

/**
 * LLM provider backed by the OpenAI Chat Completions wire protocol.
 * Thin shell delegating to the openai-completions adapter.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly adapter: OpenAICompletionsAdapter;
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    maxContextLength: 128000,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
  };

  constructor(config: ProviderConfig & { compat?: CompatFlags }) {
    this.adapter = new OpenAICompletionsAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model ?? 'gpt-4o',
      // promptCache (top-level) is the deprecated spelling of compat.streamUsage
      compat: normalizeCompat({
        ...config.compat,
        streamUsage: config.compat?.streamUsage ?? (config.promptCache === true ? true : undefined),
      }),
      thinkingLevelMap: config.thinkingLevelMap,
      reasoning: config.reasoning,
    });
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    yield* this.adapter.chat(messages, options);
  }
}
