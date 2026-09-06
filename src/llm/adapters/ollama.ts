import type { Message, StreamChunk, ChatOptions } from '../types.js';
import { withSystemPrompt } from '../messages.js';
import type { ApiAdapter, ApiAdapterConfig } from '../compat.js';

/**
 * Wire adapter for Ollama's native /api/chat endpoint (NDJSON streaming).
 * For OpenAI-compatible local servers prefer openai-completions with the
 * /v1 baseUrl instead.
 */
export class OllamaAdapter implements ApiAdapter {
  readonly api = 'ollama' as const;
  private readonly baseUrl: string;

  constructor(config: ApiAdapterConfig) {
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
            } catch {
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
