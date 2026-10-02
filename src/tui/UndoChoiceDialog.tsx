import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingUndoChoice, UndoChoice } from './hooks/undo-gate.js';
import { truncateToWidth } from './text-measure.js';
import { theme } from './theme.js';
import { TitledFrame } from './TitledFrame.js';

/** Props for the UndoChoiceDialog component. */
export interface UndoChoiceDialogProps {
  pending: PendingUndoChoice | null;
  /** Settle handler from useUndoGate (App owns the gate). */
  onSettle: (choice: UndoChoice) => void;
}

const OPTIONS: Array<{ label: string; decision: UndoChoice }> = [
  { label: 'Revert conversation + restore code', decision: 'files' },
  { label: 'Revert conversation only', decision: 'chat' },
  { label: 'Cancel', decision: 'cancel' },
];

/**
 * Two-way /undo question (context-economics ticket 03): same interaction
 * grammar as the approval dialog — number keys pick, arrows navigate,
 * Enter confirms, Esc cancels. Lists the files a code revert would restore.
 */
export function UndoChoiceDialog({ pending, onSettle }: UndoChoiceDialogProps): React.ReactElement | null {
  const [selected, setSelected] = useState(0);
  useInput((inputChar, key) => {
    if (!pending) return;
    if (inputChar >= '1' && inputChar <= '3') {
      onSettle(OPTIONS[Number(inputChar) - 1].decision);
      return;
    }
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(OPTIONS.length - 1, i + 1));
    else if (key.return) onSettle(OPTIONS[selected].decision);
    else if (key.escape) onSettle('cancel');
  });

  if (!pending) return null;

  return (
    <TitledFrame title="Undo — code changes detected" color={theme.warning} marginY={1}>
      <Text color={theme.muted} dimColor>
        The undone turn(s) wrote these files (checkpointed before the change):
      </Text>
      {pending.files.slice(0, 6).map((f) => (
        <Text key={f} color={theme.text}>
          {'  '}
          {truncateToWidth(f, 100, '...')}
        </Text>
      ))}
      {pending.files.length > 6 && (
        <Text color={theme.muted} dimColor>{`  ... ${pending.files.length - 6} more`}</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, i) => (
          <Box key={opt.decision} paddingLeft={1}>
            <Text
              inverse={i === selected}
              bold={i === selected}
              color={opt.decision === 'cancel' ? theme.error : opt.decision === 'files' ? theme.success : theme.primary}
            >
              {`${i === selected ? '> ' : '  '}${i + 1}. ${opt.label}`}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.muted} dimColor>{'1/2/3 or ↑/↓ · Enter confirm · Esc cancel'}</Text>
    </TitledFrame>
  );
}
