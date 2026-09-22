import React from 'react';
import { Box, Text } from 'ink';
import {
  getCachedBlocks,
  highlightedLines,
  highlightColor,
  parseInlineNodes,
  INLINE_STYLE,
  type InlineNode,
  type MdBlock,
  type HighlightSegment,
} from './markdown.js';
import { theme } from './theme.js';

/**
 * Render an inline token tree with styles coming from the single
 * INLINE_STYLE table (md-structured-inline 02). Markers are never emitted:
 * they are consumed by the parser, so malformed nesting cannot leak.
 */
function InlineNodes({ nodes }: { nodes: InlineNode[] }): React.ReactElement {
  return (
    <Text>
      {nodes.map((node, i) => {
        const style = INLINE_STYLE[node.kind];
        const child = node.children !== undefined ? (
          <InlineNodes nodes={node.children} />
        ) : (
          node.kind === 'br' ? '\n' : node.text ?? ''
        );
        return (
          <Text
            key={i}
            bold={style.bold}
            italic={style.italic}
            strikethrough={style.strikethrough}
            underline={style.underline}
            color={style.color}
            backgroundColor={style.backgroundColor}
          >
            {child}
            {style.hrefTail && node.href !== undefined && (
              <Text color={theme.muted} dimColor>{` (${node.href})`}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
}

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
            <InlineNodes nodes={parseInlineNodes(block.text)} />
          </Text>
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color={theme.mdListBullet}>
                {block.ordered === true ? `${(block.start ?? 1) + i}. ` : '• '}
              </Text>
              <InlineNodes nodes={parseInlineNodes(item)} />
            </Box>
          ))}
        </Box>
      );
    case 'quote':
      return (
        <Box paddingLeft={2}>
          <Text color={theme.mdQuote} italic>
            <InlineNodes nodes={parseInlineNodes(block.text)} />
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
          {block.rows.map((row, i) => (
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
          <InlineNodes nodes={parseInlineNodes(block.text)} />
        </Box>
      );
  }
}

/** Code block: syntax highlighted per line (language from the fence). */
function CodeBlock({ block }: { block: Extract<MdBlock, { kind: 'code' }> }): React.ReactElement {
  const segments = highlightedLines(block.text, block.language);
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
