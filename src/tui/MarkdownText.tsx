import React from 'react';
import { Text } from 'ink';

/** Props for the MarkdownText component. */
export interface MarkdownTextProps {
  /** Markdown-formatted text to render. */
  children: string;
}

/**
 * Renders markdown text in the terminal.
 *
 * Uses chalk-based inline formatting for:
 * - **bold** text
 * - `inline code`
 * - ```code blocks```
 * - # headers
 * - - list items
 */
export function MarkdownText({ children }: MarkdownTextProps): React.ReactElement {
  const lines = children.split('\n');
  const elements: React.ReactElement[] = [];

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `line-${i}`;

    // Handle code block boundaries
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        elements.push(
          <Text key={`codeblock-${codeBlockKey}`} backgroundColor="gray" color="white">
            {'  ' + codeBlockContent.join('\n  ')}
          </Text>,
        );
        codeBlockContent = [];
        inCodeBlock = false;
        codeBlockKey++;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      elements.push(<Text key={key} bold color="white">{line.slice(4)}</Text>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<Text key={key} bold color="cyan">{line.slice(3)}</Text>);
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<Text key={key} bold color="white">{line.slice(2)}</Text>);
      continue;
    }

    // List items
    if (line.match(/^\s*[-*]\s/)) {
      elements.push(
        <Text key={key}>
          <Text color="cyan">  • </Text>
          <Text>{renderInline(line.replace(/^\s*[-*]\s/, ''))}</Text>
        </Text>,
      );
      continue;
    }

    // Regular text with inline formatting
    elements.push(<Text key={key}>{renderInline(line)}</Text>);
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    elements.push(
      <Text key={`codeblock-${codeBlockKey}`} backgroundColor="gray" color="white">
        {'  ' + codeBlockContent.join('\n  ')}
      </Text>,
    );
  }

  return <>{elements}</>;
}

/**
 * Render inline markdown formatting: bold and inline code.
 * Returns an array of string and JSX elements.
 */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let partKey = 0;

  while (remaining.length > 0) {
    // Inline code: `...`
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)$/s);
    if (codeMatch) {
      if (codeMatch[1]) {
        parts.push(...renderBold(codeMatch[1], partKey));
        partKey += 100;
      }
      parts.push(
        <Text key={`code-${partKey}`} backgroundColor="gray" color="yellow">
          {codeMatch[2]}
        </Text>,
      );
      partKey++;
      remaining = codeMatch[3];
      continue;
    }

    // No more inline patterns; render bold only
    parts.push(...renderBold(remaining, partKey));
    break;
  }

  if (parts.length === 1 && typeof parts[0] === 'string') {
    return parts[0];
  }
  return <>{parts}</>;
}

/** Render **bold** segments within text. */
function renderBold(text: string, keyOffset: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let k = keyOffset;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*(.*)$/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(boldMatch[1]);
      parts.push(<Text key={`bold-${k}`} bold>{boldMatch[2]}</Text>);
      k++;
      remaining = boldMatch[3];
      continue;
    }
    parts.push(remaining);
    break;
  }

  return parts;
}
