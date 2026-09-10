import type { ChatOptions, Message, StreamChunk } from './types.js';

/** Wire-protocol identifiers (pi-style: API adapters are decoupled from vendors). */
export type ApiId = 'openai-completions' | 'anthropic-messages' | 'ollama';

/** Thinking levels (pi-style unified abstraction over vendor-specific params). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Map thinking levels to provider values. Values are tristate (pi semantics):
 *  - omitted: standard levels through 'high' use the default mapping
 *  - string: level supported, this value is sent to the provider
 *  - null: level unsupported (hidden/clamped)
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/**
 * Compatibility flags for third-party endpoints that imitate a wire
 * protocol but deviate in details.
 */
export interface CompatFlags {
  /**
   * openai-completions: send the system prompt as a `developer` role
   * message (recommended for newer reasoning models). Default false —
   * Nova sends a `system` message, which every OpenAI-compatible
   * endpoint understands.
   */
  supportsDeveloperRole?: boolean;
  /**
   * Request prompt-cache usage in the stream (OpenAI: stream_options).
   * Some OpenAI-compatible endpoints reject unknown stream_options.
   */
  streamUsage?: boolean;
  /** Deprecated alias of streamUsage. */
  promptCache?: boolean;
}

/** Normalized compat flags with defaults applied. */
export interface NormalizedCompat {
  supportsDeveloperRole: boolean;
  streamUsage: boolean;
}

export function normalizeCompat(flags?: CompatFlags): NormalizedCompat {
  return {
    supportsDeveloperRole: flags?.supportsDeveloperRole === true,
    streamUsage:
      flags?.streamUsage === true || (flags?.streamUsage === undefined && flags?.promptCache === true),
  };
}

/** Everything an adapter needs to talk to one endpoint. */
export interface ApiAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  compat: NormalizedCompat;
  /** Extra HTTP headers sent on every request (session/UA identity). */
  defaultHeaders?: Record<string, string>;
}

/** A wire-protocol adapter (pi-style api layer). Config is held at construction. */
export interface ApiAdapter {
  readonly api: ApiId;
  chat(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>;
}
