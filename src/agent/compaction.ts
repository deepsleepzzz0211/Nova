import type { LLMProvider } from '../llm/provider.js';
import type { Message } from '../llm/types.js';

/** Marker that prefixes the synthesized summary message. */
export const SUMMARY_MARKER = '[Conversation summary]';

/**
 * Tool results are capped during summary serialization (pi-style) so the
 * summarization request itself stays within a reasonable token budget.
 */
const TOOL_RESULT_SERIALIZE_CAP = 2000;

/** Structured summary instruction, aligned with mainstream coding agents. */
const SUMMARY_INSTRUCTION = `Summarize the conversation so far as a structured handoff. Keep it concise but complete. Include these sections when relevant:
1. User intent — what the user asked for and any constraints.
2. Files & changes — files read/created/modified, with important snippets or paths.
3. Errors & fixes — problems encountered and how they were resolved.
4. Pending work — what remains to be done.
5. Current state — what was happening right before this summary.

Output only the summary.`;

/** Options for the Compactor. */
export interface CompactorOptions {
  /**
   * Token budget of recent non-user messages kept verbatim during
   * compaction (pi-style `keepRecentTokens`). Default 20000.
   */
  keepRecentTokens?: number;
  /** Text token estimator. Default: ~4 chars/token heuristic. */
  countTokens?: (text: string) => number;
  /**
   * Compaction trigger budget (contextWindow − reserveTokens). When
   * provided, the zero-LLM placeholder pass runs first: old tool results
   * are cleared and, if that alone brings the context under the trigger,
   * the LLM summary is skipped entirely.
   */
  triggerTokens?: number;
}

/** Framing overhead assumed per message in token estimates. */
const MESSAGE_FRAMING_TOKENS = 8;

/** Result of a successful compact() call. */
export interface CompactResult {
  /** New message list (summary + kept, placeholders applied, or unchanged). */
  messages: Message[];
  /**
   * 'summary' — an LLM summary replaced old messages.
   * 'placeholder' — old tool results were cleared without any LLM call.
   * 'none' — nothing changed (nothing to compact).
   */
  method: 'summary' | 'placeholder' | 'none';
}

/**
 * Compacts a conversation by replacing older messages with an LLM-generated
 * structured summary, keeping a token-budgeted recent window verbatim.
 *
 * Keep-window rules (mainstream practice):
 * - Recent non-user messages up to `keepRecentTokens` are kept verbatim.
 * - ALL user messages are kept verbatim regardless of position — the user's
 *   own words (constraints, preferences) must not suffer summary drift.
 * - A tool call is never split from its result at the cut point.
 * - The newest message is always kept, even when it alone exceeds the budget.
 *
 * Returns null ONLY when the summarization call fails (caller should fall
 * back to truncation). "Nothing to summarize" is a success with
 * `method: 'none'` — it must not trigger the fallback.
 */
export class Compactor {
  private readonly llm: LLMProvider;
  private readonly model: string;
  private readonly keepRecentTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly triggerTokens?: number;

  constructor(llm: LLMProvider, model: string, options: CompactorOptions = {}) {
    this.llm = llm;
    this.model = model;
    this.keepRecentTokens = options.keepRecentTokens ?? 20_000;
    this.countTokens = options.countTokens ?? ((text: string) => Math.ceil(text.length / 4));
    this.triggerTokens = options.triggerTokens;
  }

  /** Rough token estimate for one message (content + tool call args). */
  private estimateMessageTokens(msg: Message): number {
    let total = MESSAGE_FRAMING_TOKENS;
    if (msg.content) total += this.countTokens(msg.content);
    if ('tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += this.countTokens(tc.function.name) + this.countTokens(tc.function.arguments);
      }
    }
    return total;
  }

  /**
   * Compact messages into [summary, ...kept].
   * Returns null when the summarization call fails (fail-open is the
   * caller's concern); returns `method: 'none'` when there is nothing
   * to compact.
   */
  async compact(messages: Message[]): Promise<CompactResult | null> {
    if (messages.length <= 1) {
      return { messages, method: 'none' };
    }

    // 1. Walk backward: keep the newest non-user messages within budget.
    //    User messages are always kept and cost no budget.
    let boundary = messages.length; // exclusive start of the keep window
    let budget = this.keepRecentTokens;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') continue;
      const cost = this.estimateMessageTokens(msg);
      // The newest message is always kept even when it alone exceeds budget.
      if (i !== messages.length - 1 && cost > budget) break;
      budget -= cost;
      boundary = i;
    }

    // 2. Cut-point rule: never split a tool call from its result. If the
    //    boundary lands on a tool result, pull its owning assistant message
    //    (and the whole call batch) back into the keep window.
    while (boundary < messages.length && messages[boundary].role === 'tool') {
      const first = messages[boundary] as { tool_call_id?: string };
      const toolId = first.tool_call_id;
      let owner = boundary;
      while (owner > 0) {
        owner--;
        const m = messages[owner];
        if (
          m.role === 'assistant' &&
          'tool_calls' in m &&
          m.tool_calls?.some((tc) => tc.id === toolId)
        ) {
          break;
        }
      }
      boundary = owner;
    }

    // 3. Partition: keep window + all user messages; summarize the rest.
    const kept = new Set<number>();
    for (let i = boundary; i < messages.length; i++) kept.add(i);
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') kept.add(i);
    }

    const toSummarize: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (!kept.has(i)) toSummarize.push(messages[i]);
    }
    if (toSummarize.length === 0) {
      return { messages, method: 'none' };
    }

    // Zero-LLM layer: clear old tool results; if that alone brings the
    // context under the trigger, skip the LLM entirely (Claude Code's
    // layer-1 "tool result trimming"). Only counts as success when at
    // least one tool result was actually cleared — otherwise it would
    // block the LLM summary without shrinking anything.
    if (this.triggerTokens !== undefined) {
      const summarizeSet = new Set(toSummarize);
      let cleared = false;
      const placeholdered = messages.map((m) => {
        if (summarizeSet.has(m) && m.role === 'tool' && m.content) {
          cleared = true;
          return { ...m, content: `[Old tool result cleared — ${m.content.length} chars]` };
        }
        return m;
      });
      if (cleared) {
        const total = placeholdered.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
        if (total <= this.triggerTokens) {
          return { messages: placeholdered, method: 'placeholder' };
        }
      }
    }

    const summary = await this.summarize(toSummarize);
    if (summary === null) {
      return null;
    }

    const keptMessages = [...kept].sort((a, b) => a - b).map((i) => messages[i]);
    return {
      messages: [
        { role: 'system', content: `${SUMMARY_MARKER}\n${summary}` },
        ...keptMessages,
      ],
      method: 'summary',
    };
  }

  /** Summarize a list of messages; returns null on failure or empty output. */
  private async summarize(messages: Message[]): Promise<string | null> {
    const transcript = messages
      .map((msg) => {
        if ('tool_calls' in msg && msg.tool_calls) {
          const calls = msg.tool_calls
            .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
            .join('; ');
          const thinkingPrefix = 'thinking' in msg && msg.thinking
            ? `[Assistant thinking] ${msg.thinking}\n`
            : '';
          return `${thinkingPrefix}${msg.role}: ${msg.content ?? ''} [tool calls: ${calls}]`;
        }
        if (msg.role === 'assistant' && 'thinking' in msg && msg.thinking) {
          return `${msg.role}: [Assistant thinking] ${msg.thinking}\n${msg.role}: ${msg.content ?? ''}`;
        }
        if (msg.role === 'tool') {
          const content = msg.content ?? '';
          if (content.length > TOOL_RESULT_SERIALIZE_CAP) {
            return `tool: ${content.slice(0, TOOL_RESULT_SERIALIZE_CAP)} …(+${content.length - TOOL_RESULT_SERIALIZE_CAP} chars truncated)`;
          }
          return `tool: ${content}`;
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
