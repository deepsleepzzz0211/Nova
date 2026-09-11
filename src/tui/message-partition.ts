import type { DisplayMessage } from './display-types.js';

/**
 * Split the conversation for Ink's <Static> region (tui-refactor ticket 08):
 * completed messages render once outside React reconciliation, while the
 * message currently streaming stays in the live region so its deltas can
 * update in place. When streaming ends the finished message joins the
 * static region (Static renders it once and Ink drops it from the live area).
 */
export interface PartitionedMessages {
  /** Completed messages — appended to Ink's <Static> list. */
  staticItems: DisplayMessage[];
  /** The in-flight message (streaming only), or null. */
  liveMessage: DisplayMessage | null;
}

export function partitionMessages(
  messages: DisplayMessage[],
  isStreaming: boolean,
): PartitionedMessages {
  if (messages.length === 0) return { staticItems: [], liveMessage: null };
  if (!isStreaming) return { staticItems: messages, liveMessage: null };
  return {
    staticItems: messages.slice(0, -1),
    liveMessage: messages[messages.length - 1],
  };
}
