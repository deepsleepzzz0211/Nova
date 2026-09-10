import React, { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { DisplayMessage } from './hooks/useAgent.js';
import { MessageBubble } from './MessageBubble.js';

/** Props for the ChatView component. */
export interface ChatViewProps {
  /** List of messages to display. */
  messages: DisplayMessage[];
  /** Id of the tool block whose details are expanded (Ctrl+O, App-level). */
  expandedToolId?: string | null;
}

/**
 * Scrollable list of chat messages.
 *
 * Renders all messages and auto-scrolls to the bottom
 * when new content is added.
 */
export function ChatView({ messages, expandedToolId }: ChatViewProps): React.ReactElement {
  const bottomRef = useRef<boolean>(true);

  // Track that we should scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current = true;
  }, [messages.length]);

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {messages.map((msg, index) => (
        <MessageBubble key={index} message={msg} expandedToolId={expandedToolId} />
      ))}
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
