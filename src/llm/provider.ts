import type { Message, StreamChunk, ChatOptions } from './types.js';
import type { CompatFlags } from './compat.js';

/** Provider interface for LLM chat completions. */
export interface LLMProvider {
  /**
   * Send messages to the LLM and receive streaming chunks.
   * @param messages - Conversation messages
   * @param options - Chat completion options
   * @returns Async iterable of stream chunks
   */
  chat(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>;
  
  /** Provider name. */
  readonly name: string;
  
  /** Provider capabilities. */
  readonly capabilities: ProviderCapabilities;
}

/** Provider capabilities. */
export interface ProviderCapabilities {
  /** Supports streaming. */
  streaming: boolean;
  
  /** Supports tool/function calling. */
  toolCalling: boolean;
  
  /** Supports vision/multimodal. */
  vision: boolean;
  
  /** Maximum context length. */
  maxContextLength: number;
  
  /** Supported models. */
  models: string[];
}

/** Provider configuration. */
export interface ProviderConfig {
  /** Provider name. */
  name: string;
  
  /** API key. */
  apiKey?: string;
  
  /** Base URL for API. */
  baseUrl?: string;
  
  /** Default model. */
  model?: string;
  
  /** Additional provider-specific config. */
  options?: Record<string, unknown>;

  /** Enable provider prompt caching + usage reporting (OpenAI stream_options). */
  promptCache?: boolean;

  /** Compatibility flags for third-party endpoint deviations. */
  compat?: CompatFlags;
}
