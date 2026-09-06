import type { LLMProvider } from '../llm/provider.js';
import type { Message } from '../llm/types.js';

/** Marker that prefixes the synthesized summary message. */
export const SUMMARY_MARKER = '[Conversation summary]';

/**
 * Structured summary instruction, aligned with how mainstream coding agents
 * compact context: preserve intent, file changes, errors/fixes, pending work.
 */
const SUMMARY_INSTRUCTION = `Summarize the conversation so far as a structured handoff. Keep it concise but complete. Include these sections when relevant:
1. User intent — what the user asked for and any constraints.
2. Files & changes — files read/created/modified, with important snippets or paths.
3. Errors & fixes — problems encountered and how they were resolved.
4. Pending work — what remains to be done.
5. Current state — what was happening right before this summary.

Output only the summary.`;

/**
 * Compacts a conversation by replacing older messages with an LLM-generated
 * structured summary, keeping the most recent messages verbatim.
 */
export class Compactor {
  private readonly llm: LLMProvider;
  private readonly model: string;
  private readonly keepRecentCount: number;

  constructor(llm: LLMProvider, model: string, keepRecentCount = 6) {
    this.llm = llm;
    this.model = model;
    this.keepRecentCount = keepRecentCount;
  }

  /**
   * Compact messages into [summary, ...recent].
   * When the history has few messages (e.g. one huge user/tool message),
   * half of them are summarized and the recent half kept verbatim.
   * Returns null when there is nothing to compact or summarization fails
   * (fail-open: the caller keeps the original messages).
   */
  async compact(messages: Message[]): Promise<Message[] | null> {
    if (messages.length <= 1) {
      return null;
    }

    const keep = messages.length <= this.keepRecentCount
      ? Math.max(1, Math.floor(messages.length / 2))
      : this.keepRecentCount;

    const old = messages.slice(0, -keep);
    const kept = messages.slice(-keep);

    const summary = await this.summarize(old);
    if (summary === null) {
      return null;
    }

    return [
      { role: 'system', content: `${SUMMARY_MARKER}\n${summary}` },
      ...kept,
    ];
  }

  /** Summarize a list of messages; returns null on failure or empty output. */
  private async summarize(messages: Message[]): Promise<string | null> {
    const transcript = messages
      .map((msg) => {
        if ('tool_calls' in msg && msg.tool_calls) {
          const calls = msg.tool_calls
            .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
            .join('; ');
          return `${msg.role}: ${msg.content ?? ''} [tool calls: ${calls}]`;
        }
        if (msg.role === 'tool') {
          return `tool: ${msg.content}`;
        }
        return `${msg.role}: ${msg.content ?? ''}`;
      })
      .join('\n');

    try {
      const stream = this.llm.chat(
        [
          { role: 'system', content: SUMMARY_INSTRUCTION },
          { role: 'user', content: `Conversation transcript:\n\n${transcript}` },
        ],
        { model: this.model },
      );

      let summary = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          summary += chunk.content;
        } else if (chunk.type === 'error') {
          return null;
        }
      }

      const trimmed = summary.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }
}
