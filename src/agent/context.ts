import { get_encoding } from 'tiktoken';
import type { Message } from '../llm/types.js';

/** Options for creating a ContextManager. */
export interface ContextManagerOptions {
  model: string;
  /** Model context window size. */
  maxTokens: number;
  /**
   * Tokens reserved for the LLM response: the compaction trigger is
   * `maxTokens − reserveTokens`. Default 16384 (pi-style), clamped to
   * half the window so tiny windows keep a sane trigger point.
   */
  reserveTokens?: number;
}

/**
 * Precise tiktoken encoder (cl100k_base), created lazily on first use.
 * Falls back to a ~4 chars/token heuristic when tiktoken cannot load.
 */
let cachedEncoding: { encode(text: string): Uint32Array } | null | undefined;

function getEncoder(): { encode(text: string): Uint32Array } | null {
  if (cachedEncoding !== undefined) {
    return cachedEncoding;
  }
  try {
    cachedEncoding = get_encoding('cl100k_base');
  } catch {
    cachedEncoding = null;
  }
  return cachedEncoding;
}

/**
 * Manages conversation context window size.
 *
 * Token counting uses tiktoken (cl100k_base) with a heuristic fallback.
 */
export class ContextManager {
  private readonly maxTokens: number;
  private readonly model: string;
  private readonly reserveTokens: number;

  constructor(options: ContextManagerOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.reserveTokens = Math.min(
      options.reserveTokens ?? 16_384,
      Math.floor(this.maxTokens / 2),
    );
  }

  /** Estimate the token count for a single piece of text. */
  countText(text: string): number {
    const encoder = getEncoder();
    if (encoder) {
      return encoder.encode(text).length;
    }
    return Math.ceil(text.length / 4);
  }

  /**
   * Count the tokens for a list of messages (framing overhead included).
   */
  countTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // role + framing overhead per message
      if (msg.content) {
        total += this.countText(msg.content);
      }
      if ('tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += this.countText(tc.function.name) + this.countText(tc.function.arguments);
        }
      }
      if ('tool_call_id' in msg && msg.tool_call_id) {
        total += 4;
      }
    }
    return total;
  }

  /** Token budget at which context management triggers. */
  get triggerTokens(): number {
    return this.maxTokens - this.reserveTokens;
  }

  /** True when the given token count is at or past the trigger point. */
  isNearLimit(tokens: number): boolean {
    return tokens >= this.triggerTokens;
  }

  /**
   * Truncate messages to fit within a target token budget.
   * Always preserves leading system messages and drops the oldest
   * non-system messages first.
   */
  truncateToTokens(messages: Message[], targetTokens: number): Message[] {
    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    let kept = [...otherMessages];
    while (kept.length > 0 && this.countTokens([...systemMessages, ...kept]) > targetTokens) {
      kept = kept.slice(1);
    }

    return [...systemMessages, ...kept];
  }

  /**
   * Truncate messages to fit within the token limit.
   * Always preserves leading system messages and drops the oldest
   * non-system messages first.
   */
  truncate(messages: Message[]): Message[] {
    return this.truncateToTokens(messages, this.maxTokens);
  }
}
