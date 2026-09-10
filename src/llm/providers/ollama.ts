import type { Message, StreamChunk, ChatOptions } from '../types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from '../provider.js';
import { OllamaAdapter } from '../adapters/ollama.js';

/**
 * LLM provider backed by Ollama's native /api/chat endpoint.
 * Thin shell delegating to the ollama adapter.
 */
export class OllamaProvider implements LLMProvider {
  private readonly adapter: OllamaAdapter;
  readonly name = 'ollama';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    maxContextLength: 32768,
    models: ['llama3', 'llama2', 'codellama', 'mistral', 'mixtral'],
  };

  constructor(config: ProviderConfig) {
    this.adapter = new OllamaAdapter({
      apiKey: config.apiKey,
      defaultHeaders: config.defaultHeaders,
      baseUrl: config.baseUrl,
      model: config.model ?? 'llama3',
      compat: { supportsDeveloperRole: false, streamUsage: false },
    });
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    yield* this.adapter.chat(messages, options);
  }
}
