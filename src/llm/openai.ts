import OpenAI from 'openai';
import type { Message, StreamChunk, ChatOptions } from './types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from './provider.js';
import { parseOpenAIStream } from './stream.js';
import { withSystemPrompt } from './messages.js';

/**
 * LLM provider backed by the OpenAI Chat Completions API (or compatible).
 * Uses streaming and delegates chunk parsing to parseOpenAIStream.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly promptCache: boolean;
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    maxContextLength: 128000,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
  };

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.promptCache = config.promptCache === true;
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model,
        messages: withSystemPrompt(messages, options.systemPrompt) as OpenAI.ChatCompletionMessageParam[],
        stream: true,
        tools: options.tools as OpenAI.ChatCompletionTool[],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        // Opt-in: report prompt-cache usage on the final chunk. Some
        // OpenAI-compatible endpoints reject unknown stream_options, so this
        // is only enabled when prompt caching is explicitly requested.
        ...(this.promptCache ? { stream_options: { include_usage: true } } : {}),
      });

      yield* parseOpenAIStream(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}
