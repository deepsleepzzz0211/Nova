import React from 'react';
import { Box, Text } from 'ink';
import {
  getCachedBlocks,
  highlightedLines,
  highlightColor,
  inlineText,
  type MdBlock,
  type HighlightSegment,
} from './markdown.js';
import { theme } from './theme.js';

/** Props for the MarkdownText component. */
export interface MarkdownTextProps {
  /** Markdown source (may be a partially streamed document). */
  children: string;
}

/**
 * Renders markdown for the chat view (tui-refactor ticket 07): marked
 * parsing with per-message caching, code blocks syntax-highlighted via
 * highlight.js, and graceful degradation while a message streams.
 */
export function MarkdownText({ children }: MarkdownTextProps): React.ReactElement {
  const blocks = getCachedBlocks(children);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </Box>
  );
}

function Block({ block }: { block: MdBlock }): React.ReactElement {
  switch (block.kind) {
    case 'heading':
      return (
        <Box marginY={0}>
          <Text bold color={theme.mdHeading}>
            {inlineText(block.text)}
          </Text>
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items?.map((item, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color={theme.mdListBullet}>
                {block.ordered === true ? `${(block.start ?? 1) + i}. ` : '• '}
              </Text>
              <Text>{inlineText(item)}</Text>
            </Box>
          ))}
        </Box>
      );
    case 'quote':
      return (
        <Box paddingLeft={2}>
          <Text color={theme.mdQuote} italic>
            {inlineText(block.text)}
          </Text>
        </Box>
      );
    case 'code':
      return <CodeBlock block={block} />;
    case 'rule':
      return (
        <Box>
          <Text color={theme.muted} dimColor>{'─'.repeat(24)}</Text>
        </Box>
      );
    case 'table':
      return (
        <Box flexDirection="column">
          {block.rows?.map((row, i) => (
            <Box key={i}>
              <Text bold={i === 0} color={i === 0 ? theme.mdTableHeader : undefined}>
                {row.join(' | ')}
              </Text>
            </Box>
          ))}
        </Box>
      );
    case 'paragraph':
    default:
      return (
        <Box>
          <Text>{inlineText(block.text)}</Text>
        </Box>
      );
  }
}

/** Code block: syntax highlighted per line (language from the fence). */
function CodeBlock({ block }: { block: MdBlock }): React.ReactElement {
  const segments = highlightedLines(block.text, block.language ?? null);
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      {segments.map((line, i) => (
        <Box key={i}>
          <Text color={theme.mdCode} dimColor>{'│ '}</Text>
          {line.length === 0 ? (
            <Text> </Text>
          ) : (
            line.map((seg: HighlightSegment, j: number) => (
              <Text key={j} color={highlightColor(seg.className)}>
                {seg.text}
              </Text>
            ))
          )}
        </Box>
      ))}
    </Box>
  );
}
