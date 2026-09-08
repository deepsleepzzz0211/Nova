/**
 * LLM API error classification.
 *
 * Providers surface context-window exhaustion with different messages and
 * error shapes. Token estimates can never be exact (tiktoken vocabularies
 * differ per model), so a reactive safety net must recognize overflow
 * errors regardless of provider.
 */

/** Message fragments that identify a context-window overflow error. */
const OVERFLOW_PATTERNS: readonly string[] = [
  // OpenAI / OpenAI-compatible
  'maximum context length',
  'context_length_exceeded',
  'context length exceeded',
  // Anthropic
  'prompt is too long',
  'request exceeds the maximum allowed',
  // Generic
  'input length exceeds',
  'conversation exceeds the context window',
  'too many input tokens',
];

/**
 * True when the error indicates the request exceeded the model's context
 * window (as opposed to auth failures, rate limits, network errors...).
 */
export function isContextOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message) return false;
  const lower = message.toLowerCase();
  return OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}
