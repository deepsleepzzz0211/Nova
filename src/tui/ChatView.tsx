import React from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayMessage } from './display-types.js';
import { MessageBubble } from './MessageBubble.js';
import type { DisplayKindResolver } from './tool-summary.js';
import { partitionMessages } from './message-partition.js';

/** Props for the ChatView component. */
export interface ChatViewProps {
  /** List of messages to display. */
  messages: DisplayMessage[];
  /** Ids of tool blocks whose details are expanded (Ctrl+O, App-level). */
  expandedToolIds?: ReadonlySet<string>;
  /** Registry-backed tool display kind resolver. */
  displayKind?: DisplayKindResolver;
  /**
   * Conversation epoch. Bump it when the message list is REPLACED wholesale
   * (/undo): Ink's static region is append-only, so it must be remounted
   * (new key) for the restored conversation to print at all.
   */
  staticEpoch?: number;
  /**
   * Diagnostics/test seam: called with each rendered message and whether it
   * came from the static or the live region (used to prove the static
   * region does not re-render on stream deltas).
   */
  renderProbe?: (region: 'static' | 'live', message: DisplayMessage) => void;
}

/**
 * List of chat messages (tui-refactor tickets 08/07): finalised turns go
 * through Ink's <Static> (written once, outside reconciliation), while the
 * current turn — streaming answer, mid-turn notices, expandable tool
 * blocks — stays in the live region.
 */
export function ChatView({
  messages,
  expandedToolIds,
  displayKind,
  staticEpoch = 0,
  renderProbe,
}: ChatViewProps): React.ReactElement {
  const { staticItems, liveItems } = partitionMessages(messages);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static key={staticEpoch} items={staticItems}>
        {(msg, index) => {
          renderProbe?.('static', msg);
          return (
            <MessageBubble
              key={index}
              message={msg}
              expandedToolIds={expandedToolIds}
              displayKind={displayKind}
            />
          );
        }}
      </Static>
      {liveItems.map((msg, index) => {
        renderProbe?.('live', msg);
        return (
          <MessageBubble
            key={`live-${index}`}
            message={msg}
            expandedToolIds={expandedToolIds}
            displayKind={displayKind}
          />
        );
      })}
      {messages.length === 0 && (
        <Box paddingY={1}>
          <Box paddingLeft={2}>
            <Text color="gray" dimColor>
              Welcome to Nova. Type a message to get started.
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
