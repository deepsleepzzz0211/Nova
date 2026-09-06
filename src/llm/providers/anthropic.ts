import Anthropic from '@anthropic-ai/sdk';
import type { Message, StreamChunk, ChatOptions } from '../types.js';
import type { LLMProvider, ProviderCapabilities, ProviderConfig } from '../provider.js';
import { withSystemPrompt } from '../messages.js';

/**
 * LLM provider backed by the Anthropic API.
 * Supports streaming and tool use.
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
      // Convert messages to Anthropic format
      const fullMessages = withSystemPrompt(messages, options.systemPrompt);
      const systemMessage = fullMessages.find(m => m.role === 'system');
      const conversationMessages = fullMessages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        }));

      const stream = this.client.messages.stream({
        model: options.model,
        max_tokens: options.maxTokens || 4096,
        system: systemMessage?.content || undefined,
        messages: conversationMessages,
        tools: options.tools as any[],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', content: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield { type: 'tool_call_delta', id: '', arguments: event.delta.partial_json };
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            yield { 
              type: 'tool_call_start', 
              id: event.content_block.id, 
              name: event.content_block.name 
            };
          }
        } else if (event.type === 'content_block_stop') {
          // Handle tool call end if needed
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }
}