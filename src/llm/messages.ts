import type { Message } from './types.js';

/**
 * Ensure the system prompt reaches the provider.
 *
 * Providers declare the system prompt in ChatOptions.systemPrompt while the
 * conversation history may also contain system messages (e.g. compaction
 * summaries). This helper prepends the option-based prompt when the history
 * does not already start with one, so no provider silently drops it.
 */
export function withSystemPrompt(messages: Message[], systemPrompt?: string): Message[] {
  if (!systemPrompt) return messages;
  if (messages[0]?.role === 'system') return messages;
  return [{ role: 'system', content: systemPrompt }, ...messages];
}
