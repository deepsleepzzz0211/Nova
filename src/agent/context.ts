import type { Message } from '../llm/types.js';

/** Options for creating a ContextManager. */
export interface ContextManagerOptions {
  model: string;
  maxTokens: number;
}

/**
 * Manages conversation context window size.
 *
 * Uses a simple character-based heuristic (~4 chars per token) for v1.
 * Can be upgraded to tiktoken or similar later.
 */
export class ContextManager {
  private readonly maxTokens: number;
  private readonly model: string;

  constructor(options: ContextManagerOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  /**
   * Estimate the token count for a list of messages.
   * Heuristic: ~4 characters per token for English text.
   */
  countTokens(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      // Count role label overhead (~4 tokens per message for framing)
      totalChars += 16;
      if (msg.content) {
        totalChars += msg.content.length;
      }
      if ('tool_calls' in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += tc.function.name.length + tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(totalChars / 4);
  }

  /**
   * Truncate messages to fit within the token limit.
   * Always preserves the system message (if present) and drops the oldest
   * non-system messages first.
   */
  truncate(messages: Message[]): Message[] {
    // Separate system messages from the rest
    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    // If already under limit, return as-is
    if (this.countTokens(messages) <= this.maxTokens) {
      return messages;
    }

    // Drop oldest non-system messages until we fit
    const kept: Message[] = [...otherMessages];
    while (kept.length > 0 && this.countTokens([...systemMessages, ...kept]) > this.maxTokens) {
      kept.shift();
    }

    return [...systemMessages, ...kept];
  }

  /**
   * Returns true if the current token usage exceeds 80% of maxTokens.
   */
  isNearLimit(currentTokens: number): boolean {
    return currentTokens > this.maxTokens * 0.8;
  }
}
