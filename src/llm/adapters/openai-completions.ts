import OpenAI from 'openai';
import type { Message, StreamChunk, ChatOptions } from '../types.js';
import { parseOpenAIStream } from '../stream.js';
import { withSystemPrompt } from '../messages.js';
import type { ApiAdapter, ApiAdapterConfig, NormalizedCompat } from '../compat.js';

/**
 * Wire adapter for the OpenAI Chat Completions API — the most common
 * compatibility target (OpenAI, vLLM, LM Studio, OpenRouter, gateways).
 *
 * compat flags:
 *  - supportsDeveloperRole: system prompt sent as `developer` role
 *  - streamUsage: request prompt-cache usage via stream_options
 */
export class OpenAICompletionsAdapter implements ApiAdapter {
  readonly api = 'openai-completions' as const;
  private readonly client: OpenAI;
  private readonly compat: NormalizedCompat;

  constructor(config: ApiAdapterConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.compat = config.compat;
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model,
        messages: withSystemPrompt(messages, options.systemPrompt, this.compat.supportsDeveloperRole ? 'developer' : 'system') as OpenAI.ChatCompletionMessageParam[],
        stream: true,
        tools: options.tools as OpenAI.ChatCompletionTool[],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        // Opt-in: report prompt-cache usage on the final chunk. Some
        // OpenAI-compatible endpoints reject unknown stream_options.
        ...(this.compat.streamUsage ? { stream_options: { include_usage: true } } : {}),
      });

      yield* parseOpenAIStream(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}
