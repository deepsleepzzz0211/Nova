import React from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayMessage } from './hooks/useAgent.js';
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
  /** Whether a response is currently streaming (keeps it in the live area). */
  isStreaming?: boolean;
}

/**
 * List of chat messages. Ink keeps the newest content visible; completed
 * messages join the static region in ticket 08 (no internal scrolling yet).
 */
export function ChatView({
  messages,
  expandedToolIds,
  displayKind,
  isStreaming = false,
}: ChatViewProps): React.ReactElement {
  const { staticItems, liveMessage } = partitionMessages(messages, isStreaming);
  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {/* Completed messages render once via <Static>; only the in-flight
          message (plus the regions below) re-renders while streaming. */}
      <Static items={staticItems}>
        {(msg, index) => (
          <MessageBubble
            key={index}
            message={msg}
            expandedToolIds={expandedToolIds}
            displayKind={displayKind}
          />
        )}
      </Static>
      {liveMessage !== null && (
        <MessageBubble
          message={liveMessage}
          expandedToolIds={expandedToolIds}
          displayKind={displayKind}
        />
      )}
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
