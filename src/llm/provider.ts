import type { Message, StreamChunk, ChatOptions } from './types.js';

/** Provider interface for LLM chat completions. */
export interface LLMProvider {
  /**
   * Send messages to the LLM and receive streaming chunks.
   * @param messages - Conversation messages
   * @param options - Chat completion options
   * @returns Async iterable of stream chunks
   */
  chat(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>;
}
