import type { Message, StreamChunk, ChatOptions } from '../types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from '../provider.js';
import { withSystemPrompt } from '../messages.js';

/**
 * LLM provider backed by Ollama API.
 * Supports local models with streaming.
 */
export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  readonly name = 'ollama';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    maxContextLength: 32768,
    models: ['llama3', 'llama2', 'codellama', 'mistral', 'mixtral'],
  };

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages: withSystemPrompt(messages, options.systemPrompt).map(m => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
          options: {
            num_predict: options.maxTokens,
            temperature: options.temperature,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                yield { type: 'text_delta', content: data.message.content };
              }
              if (data.done) {
                return;
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}