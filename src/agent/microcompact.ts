import type { Message } from '../llm/types.js';

/**
 * Microcompact (zero-LLM context layer): clear OLD tool results down to a
 * placeholder, keeping the newest groups verbatim. Runs before truncate /
 * summary compaction so most pressure passes cost no model call.
 */

/** Prefix shared with the compaction placeholder pass; marks cleared content. */
export const MICROCOMPACT_MARKER = '[Old tool result cleared';

/**
 * Tools whose results are cheap to re-derive (re-read / re-run) and typically
 * large. Anything else — including results with no known owning call — is
 * never cleared (fail-closed).
 */
export const DEFAULT_MICROCOMPACT_TOOLS: readonly string[] = [
  'read_file',
  'bash',
  'web_fetch',
  'web_search',
];

/** Options for {@link microcompactMessages}. */
export interface MicrocompactOptions {
  /** Newest tool-result groups kept verbatim. Default 5. */
  keepRecentGroups?: number;
  /** Pass is skipped unless estimated savings reach this. Default 256. */
  minSavingsTokens?: number;
  /** Tool names whose results may be cleared. Default the built-in list. */
  compactableTools?: readonly string[];
  /**
   * Token estimator. Required so savings math cannot silently diverge from
   * the caller's context manager.
   */
  countTokens: (text: string) => number;
}

/** Result of a microcompact pass. */
export interface MicrocompactResult {
  messages: Message[];
  applied: boolean;
  clearedResults: number;
  savedTokens: number;
}

function untouched(messages: Message[]): MicrocompactResult {
  return { messages, applied: false, clearedResults: 0, savedTokens: 0 };
}

const DEFAULT_KEEP_RECENT_GROUPS = 5;
const DEFAULT_MIN_SAVINGS_TOKENS = 256;

/** Inline media (base64 images etc.) arrives as data URLs in string content. */
const DATA_URL_PREFIX = /^data:[^,;]+[,;]/;

/**
 * Clear tool results outside the newest `keepRecentGroups` groups.
 * Pure: never mutates the input; returns the SAME array reference when
 * nothing was cleared. A "group" is one contiguous run of tool results
 * (one tool-call batch).
 */
export function microcompactMessages(
  messages: Message[],
  options: MicrocompactOptions,
): MicrocompactResult {
  const keep = options.keepRecentGroups ?? DEFAULT_KEEP_RECENT_GROUPS;
  const minSavings = options.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS;
  const whitelist = options.compactableTools ?? DEFAULT_MICROCOMPACT_TOOLS;
  const count = options.countTokens;

  // Owning tool name per call id — unknown ids are never cleared.
  const nameByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) nameByCallId.set(tc.id, tc.function.name);
    }
  }

  // Group ordinal for every tool message (contiguous runs = one batch).
  const groupOf = new Map<number, number>();
  let group = -1;
  let prevWasTool = false;
  messages.forEach((m, i) => {
    if (m.role !== 'tool') {
      prevWasTool = false;
      return;
    }
    if (!prevWasTool) group += 1;
    groupOf.set(i, group);
    prevWasTool = true;
  });

  const totalGroups = group + 1;
  if (totalGroups === 0 || totalGroups <= keep) return untouched(messages);

  const out = [...messages];
  let cleared = 0;
  let saved = 0;
  for (const [index, ordinal] of groupOf) {
    if (ordinal >= totalGroups - keep) continue; // recent window stays verbatim
    const m = messages[index] as Extract<Message, { role: 'tool' }>;
    if (m.content === '' || m.content.startsWith(MICROCOMPACT_MARKER)) continue;
    // Media payloads ride as data URLs in string content; never cleared.
    if (DATA_URL_PREFIX.test(m.content)) continue;
    const name = nameByCallId.get(m.tool_call_id);
    if (name === undefined || !whitelist.includes(name)) continue;
    const placeholder = `${MICROCOMPACT_MARKER} — ${name} — ${m.content.length} chars]`;
    const delta = count(m.content) - count(placeholder);
    if (delta <= 0) continue; // already small: clearing saves nothing
    out[index] = { ...m, content: placeholder };
    cleared += 1;
    saved += delta;
  }

  if (cleared === 0 || saved < minSavings) return untouched(messages);
  return { messages: out, applied: true, clearedResults: cleared, savedTokens: saved };
}
