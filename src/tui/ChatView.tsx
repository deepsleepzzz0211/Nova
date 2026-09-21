import React from 'react';
import { Box, Static, Text } from 'ink';
import type { DisplayMessage } from './display-types.js';
import { MessageBubble } from './MessageBubble.js';
import type { DisplayKindResolver } from './tool-summary.js';
import { partitionMessages } from './message-partition.js';
import { viewportSlice } from './viewport.js';
import { findMatches } from './fullscreen-input.js';
import { theme } from './theme.js';
import type { WelcomeCard } from './header.js';

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
  viewport?: { scrollOffset: number; terminalRows: number; terminalWidth?: number };
  /**
   * Inline search (ticket 13): when present, only matching messages are shown
   * and a header reports the current hit.
   */
  search?: { query: string; index: number };
  /**
   * Welcome card (tui-redesign 06): printed once as the first static item,
   * scrolling into history like any completed message. In fullscreen (which
   * windows the transcript instead) it shows while the conversation is empty.
   */
  welcome?: WelcomeCard;
  /** True while the model streams reasoning (thought header, ticket 09). */
  thinkingActive?: boolean;
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
  search,
  welcome,
  thinkingActive,
}: ChatViewProps): React.ReactElement {
  // Search narrows the transcript to matching messages (ticket 13).
  const searchMatches = search !== undefined ? findMatches(messages, search.query) : [];
  const searchResult =
    search !== undefined && searchMatches.length > 0
      ? messages[searchMatches[Math.min(search.index, searchMatches.length - 1)].messageIndex]
      : undefined;
  // While searching, the transcript narrows to the current hit; otherwise
  // fullscreen slices the conversation to the visible window (auto-scroll is
  // owned by App, which keeps the offset at the end while streaming).
  const baseMessages = searchResult !== undefined ? [searchResult] : messages;
  const windowed =
    viewport !== undefined && search === undefined
      ? viewportSlice(baseMessages, {
          // Conservative budget: status bar + editor + hint + slack.
          rows: Math.max(3, viewport.terminalRows - 8),
          offset: viewport.scrollOffset,
          expandedToolIds,
          // Real terminal columns so the wrap estimate matches Ink's rendering
          // (zcode-borrow ticket 09); omit → estimator falls back to 80.
          ...(viewport.terminalWidth === undefined ? {} : { width: viewport.terminalWidth }),
        })
      : null;
  const visibleMessages = windowed?.messages ?? baseMessages;
  const { staticItems: staticMessages, liveItems } = partitionMessages(visibleMessages);
  // Static list is a small union so the welcome card can lead it.
  type StaticItem = { kind: 'msg'; message: DisplayMessage } | { kind: 'welcome'; card: WelcomeCard };
  const staticItems: StaticItem[] = [
    ...(welcome !== undefined ? [{ kind: 'welcome', card: welcome } as const] : []),
    ...staticMessages.map((message) => ({ kind: 'msg', message }) as const),
  ];

  return (
    <Box flexDirection="column" flexGrow={1}>
      {search !== undefined && (
        <Box paddingLeft={2}>
          <Text color={theme.primary}>
            {searchMatches.length === 0
              ? `/ search: ${search.query} (no matches)`
              : `/ search: ${search.query} (${Math.min(search.index, searchMatches.length - 1) + 1}/${searchMatches.length}) — n/N step, Esc close`}
          </Text>
        </Box>
      )}
      {windowed !== null && windowed.hiddenAbove > 0 && (
        <Box paddingLeft={2}>
          <Text color={theme.muted} dimColor>
            {`↑ ${windowed.hiddenAbove} earlier message(s) — PageUp/PageDown to scroll`}
          </Text>
        </Box>
      )}
      {/* Fullscreen windows the conversation itself, so Static (append-only)
          is skipped there; the regular mode still writes each completed
          message once. The welcome card leads the static list so it scrolls
          into history as the transcript grows (tui-redesign 06). */}
      <Static key={staticEpoch} items={windowed !== null ? [] : staticItems}>
        {(msg, index) => {
          if (msg.kind === 'welcome') {
            return <WelcomeCardView key="welcome" card={msg.card} />;
          }
          renderProbe?.('static', msg.message);
          return (
            <MessageBubble
              key={index}
              message={msg.message}
              expandedToolIds={expandedToolIds}
              displayKind={displayKind}
              thinkingExpanded={expandedToolIds?.has(`msg:${messages.indexOf(msg.message)}`) ?? false}
            />
          );
        }}
      </Static>
      {(windowed !== null ? visibleMessages : liveItems).map((msg, index) => {
        renderProbe?.('live', msg);
        const isTail = index === (windowed !== null ? visibleMessages : liveItems).length - 1;
        return (
          <MessageBubble
            key={`live-${index}`}
            message={msg}
            expandedToolIds={expandedToolIds}
            displayKind={displayKind}
            thinkingExpanded={expandedToolIds?.has(`msg:${messages.indexOf(msg)}`) ?? false}
            thinkingActive={isTail && thinkingActive === true}
          />
        );
      })}
      {/* Fullscreen has no static region: the card shows in the empty state
          and disappears once the conversation starts (ZCode behaviour). */}
      {windowed !== null && messages.length === 0 && welcome !== undefined && (
        <WelcomeCardView card={welcome} />
      )}
      {messages.length === 0 && welcome === undefined && (
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

/** Logo + meta + tip lines of the welcome card (tui-redesign ticket 06). */
function WelcomeCardView({ card }: { card: WelcomeCard }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingBottom={1}>
      {card.logo.map((row, i) => (
        <Text key={i} color={theme.primary}>{row}</Text>
      ))}
      <Text color={theme.muted} dimColor>{card.meta}</Text>
      <Text color={theme.muted} dimColor>{`Tip: ${card.tip}`}</Text>
    </Box>
  );
}
