import React from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayMessage } from './display-types.js';
import { MessageBubble } from './MessageBubble.js';
import type { DisplayKindResolver } from './tool-summary.js';
import { partitionMessages } from './message-partition.js';
import { viewportSlice } from './viewport.js';
import { theme } from './theme.js';

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
  /**
   * Fullscreen viewport (ticket 12): when present, only the messages that fit
   * the terminal rows are rendered, anchored at the newest unless the user
   * scrolled back. Auto-scroll stays in control of the offset.
   */
  viewport?: { scrollOffset: number; terminalRows: number };
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
  viewport,
}: ChatViewProps): React.ReactElement {
  // Fullscreen: slice the conversation to the visible window. Auto-scroll
  // (App) keeps the offset at the end while streaming.
  const windowed = viewport !== undefined
    ? viewportSlice(messages, {
        // Conservative budget: status bar + editor + hint + estimation slack.
        rows: Math.max(3, viewport.terminalRows - 8),
        offset: viewport.scrollOffset,
        expandedToolIds,
      })
    : null;
  const visibleMessages = windowed?.messages ?? messages;
  const { staticItems, liveItems } = partitionMessages(visibleMessages);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {windowed !== null && windowed.hiddenAbove > 0 && (
        <Box paddingLeft={2}>
          <Text color={theme.muted} dimColor>
            {`↑ ${windowed.hiddenAbove} earlier message(s) — PageUp/PageDown to scroll`}
          </Text>
        </Box>
      )}
      {/* Fullscreen windows the conversation itself, so Static (append-only)
          is skipped there; the regular mode still writes each completed
          message once. */}
      <Static key={staticEpoch} items={windowed !== null ? [] : staticItems}>
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
      {(windowed !== null ? visibleMessages : liveItems).map((msg, index) => {
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
            <Text color={theme.muted} dimColor>
              Welcome to Nova. Type a message to get started.
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
