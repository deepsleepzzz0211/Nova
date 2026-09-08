import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionSummary } from '../agent/session.js';

/**
 * Pure formatter for `--list` output (stable, script-consumable):
 * `NN. YYYY-MM-DD HH:mm  <messages> msgs  <preview>`
 */
export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return 'No sessions found.';
  return sessions
    .map((s, i) => {
      const date = new Date(s.mtimeMs);
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      const preview = s.preview.length > 0 ? s.preview : '(no user messages)';
      return `${String(i + 1).padStart(2)}. ${ts}  ${String(s.messageCount).padStart(4)} msgs  ${preview}`;
    })
    .join('\n');
}

/** Interactive session picker: up/down to move, Enter to select, Esc to cancel. */
export function SessionPicker({
  sessions,
  defaultIndex,
  onPick,
}: {
  sessions: SessionSummary[];
  defaultIndex: number;
  onPick: (session: SessionSummary | null) => void;
}): React.ReactElement {
  const [index, setIndex] = useState(defaultIndex);

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
    } else if (key.return) {
      onPick(sessions[index]);
    } else if (key.escape) {
      onPick(null);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Resume a session</Text>
      <Text dimColor>↑/↓ move · Enter resume · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.map((s, i) => (
          <Box key={s.file}>
            <Text color={i === index ? 'cyan' : undefined} bold={i === index}>
              {i === index ? '❯ ' : '  '}
              {formatSessionList([s])}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
