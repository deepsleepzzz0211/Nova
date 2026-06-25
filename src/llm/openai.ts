import OpenAI from 'openai';
import type { Message, StreamChunk, ChatOptions } from './types.js';
import type { LLMProvider } from './provider.js';
import { parseOpenAIStream } from './stream.js';

/** Configuration for the OpenAI provider. */
export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * LLM provider backed by the OpenAI Chat Completions API (or compatible).
 * Uses streaming and delegates chunk parsing to parseOpenAIStream.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        stream: true,
        tools: options.tools as OpenAI.ChatCompletionTool[],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
      });

      yield* parseOpenAIStream(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}
