import type { DisplayMessage } from './display-types.js';

/**
 * Split the conversation for Ink's <Static> region (tui-refactor ticket 08).
 *
 * Ink's static output is APPEND-ONLY: an item written once is never
 * reprinted, so only immutable content may go there. The live region is
 * therefore the whole current turn — every message from the last user
 * message onwards — because:
 *   - the streaming answer updates in place (32ms deltas),
 *   - notices appended mid-turn (subagent activity, compaction) must not
 *     push the in-flight answer into the static region half-written
 *     (that duplicated the text: review finding),
 *   - tool blocks of the latest turn stay expandable with Ctrl+O (a
 *     static message could never re-render on expansion).
 *
 * Everything before the last user message is final and goes to <Static>.
 * When the conversation is replaced wholesale (/undo), the caller must
 * remount the Static region with a new key so its index resets.
 */
export interface PartitionedMessages {
  /** Finalised messages — appended to Ink's <Static> list. */
  staticItems: DisplayMessage[];
  /** The current turn's messages, re-rendered as they change. */
  liveItems: DisplayMessage[];
}

export function partitionMessages(messages: DisplayMessage[]): PartitionedMessages {
  if (messages.length === 0) return { staticItems: [], liveItems: [] };

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  // No user message yet (startup notices): everything stays live, which is
  // always safe because the live region is the normal render path.
  if (lastUserIndex === -1) return { staticItems: [], liveItems: messages };

  return {
    staticItems: messages.slice(0, lastUserIndex),
    liveItems: messages.slice(lastUserIndex),
  };
}

/**
 * Newest expandable block for the Ctrl+O cycle (tui-redesign 09): returns a
 * tool-call id, or `msg:<index>` when the newest expandable thing is an
 * assistant thought, or null when there is nothing to expand.
 */
export function latestExpandableId(messages: DisplayMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const calls = m.toolCalls;
    if (calls !== undefined && calls.length > 0) return calls[calls.length - 1].id;
    if (m.role === 'assistant' && m.thinking !== undefined && m.thinking !== '') {
      return `msg:${i}`;
    }
  }
  return null;
}
