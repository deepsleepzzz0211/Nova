import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { displayWidth } from './text-measure.js';

/**
 * Hand-drawn rounded frame with a title embedded in the top edge
 * (tui-redesign ticket 03/04): Ink's built-in borderStyle cannot carry a
 * title, so the three chrome rows are drawn from box-drawing characters and
 * sized with display-width maths so the corners never misalign.
 */
export function TitledFrame({
  title,
  color,
  marginY,
  children,
}: {
  title: string;
  color: string;
  marginY?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const head = `╭─ ${title} `;
  const top = head + '─'.repeat(Math.max(2, cols - displayWidth(head) - 1)) + '╮';
  const bottom = '╰' + '─'.repeat(Math.max(2, cols - 2)) + '╯';
  return (
    <Box flexDirection="column" marginY={marginY ?? 0}>
      <Text color={color}>{top}</Text>
      <Box flexDirection="column" paddingX={1}>
        {children}
      </Box>
      <Text color={color}>{bottom}</Text>
    </Box>
  );
}
