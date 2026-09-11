import React from 'react';
import { Box, Text } from 'ink';
import hljs from 'highlight.js';
import {
  getCachedBlocks,
  highlightToSegments,
  type MdBlock,
} from './markdown.js';

/** Props for the MarkdownText component. */
export interface MarkdownTextProps {
  /** Markdown source (may be a partially streamed document). */
  children: string;
}

/** hljs class name → terminal color (theme tokens arrive with ticket 11). */
const HLJS_COLORS: Array<{ match: RegExp; color: string }> = [
  { match: /keyword|built_in|literal|type|class/, color: 'magenta' },
  { match: /string|regexp|char/, color: 'green' },
  { match: /comment|quote/, color: 'gray' },
  { match: /number|attr|variable/, color: 'yellow' },
  { match: /title|function|name/, color: 'cyan' },
];

function colorFor(className: string | null): string | undefined {
  if (className === null) return undefined;
  return HLJS_COLORS.find((entry) => entry.match.test(className))?.color;
}

/** Inline markdown stripped to plain text (bold/code markers removed). */
function inlineText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
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
          <Text bold color="cyan">
            {inlineText(block.text)}
          </Text>
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items?.map((item, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color="gray">{block.ordered === true ? `${i + 1}. ` : '• '}</Text>
              <Text>{inlineText(item)}</Text>
            </Box>
          ))}
        </Box>
      );
    case 'quote':
      return (
        <Box paddingLeft={2}>
          <Text color="gray" italic>
            {inlineText(block.text)}
          </Text>
        </Box>
      );
    case 'code':
      return <CodeBlock block={block} />;
    case 'table':
      return (
        <Box flexDirection="column">
          {block.rows?.map((row, i) => (
            <Box key={i}>
              <Text bold={i === 0} color={i === 0 ? 'cyan' : undefined}>
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
  const segments = highlightedSegments(block);
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      {segments.map((line, i) => (
        <Box key={i}>
          <Text color="gray" dimColor>{'│ '}</Text>
          {line.length === 0 ? (
            <Text> </Text>
          ) : (
            line.map((seg, j) => (
              <Text key={j} color={colorFor(seg.className)}>
                {seg.text}
              </Text>
            ))
          )}
        </Box>
      ))}
    </Box>
  );
}

/** Highlight one code block into per-line segments. */
function highlightedSegments(block: MdBlock): Array<Array<{ text: string; className: string | null }>> {
  let html: string;
  try {
    if (block.language !== null && block.language !== undefined && hljs.getLanguage(block.language)) {
      html = hljs.highlight(block.text, { language: block.language, ignoreIllegals: true }).value;
    } else {
      html = hljs.highlightAuto(block.text).value;
    }
  } catch {
    html = block.text;
  }
  // hljs output is per-line already; split on newlines before segmenting so
  // each rendered row keeps its own colors.
  return html.split('\n').map((line) => highlightToSegments(line));
}
