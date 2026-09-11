import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingPermission } from './hooks/useAgent.js';
import type { PermissionDecision } from './permission-display.js';
import { describeCall, dangerReason } from './permission-display.js';
import type { DisplayKindResolver } from './tool-summary.js';

/** Props for the PermissionDialog component. */
export interface PermissionDialogProps {
  /** The pending permission request, or null if none. */
  pending: PendingPermission | null;
  /** Registry-backed tool display kind resolver (command/path). */
  displayKind?: DisplayKindResolver;
}

/** Options shown, in display order (option 3 is excluded for dangerous calls). */
const OPTIONS: Array<{ key: '1' | '2' | '3'; label: string; decision: PermissionDecision }> = [
  { key: '1', label: 'No', decision: 'deny' },
  { key: '2', label: 'Yes', decision: 'allow' },
  { key: '3', label: "Yes, always (this session)", decision: 'always' },
];

/**
 * Inline permission options list (tui-refactor ticket 04).
 *
 * - Number keys (1/2/3) pick directly; up/down + Enter navigates; Esc = No
 * - Shows a typed description of the call (command / path / JSON), not raw
 *   argument JSON
 * - Dangerous calls (registry-derived patterns) stay highlighted in red
 * - "Yes, always" records a session-scoped rule in useAgent; the dialog
 *   itself is purely presentational over the decision callback
 */
export function PermissionDialog({ pending, displayKind }: PermissionDialogProps): React.ReactElement | null {
  // Rules of hooks: all hooks run unconditionally; the early return below
  // comes AFTER all hooks (tui-refactor ticket 01).
  const [selected, setSelected] = useState(0);
  // Ref mirror: key events can burst before React re-renders (lessons.md #9).
  const selectedRef = useRef(0);
  // A new request must not inherit the previous selection (review: the
  // stale "3. Yes, always" highlight could auto-approve the next call).
  useEffect(() => {
    selectedRef.current = 0;
    setSelected(0);
  }, [pending]);
  const move = (fn: (i: number) => number): void => {
    const next = Math.max(0, Math.min(OPTIONS.length - 1, fn(selectedRef.current)));
    selectedRef.current = next;
    setSelected(next);
  };
  useInput((inputChar, key) => {
    if (!pending) return;
    if (inputChar === '1' || inputChar === '2' || inputChar === '3') {
      pending.resolve(OPTIONS[Number(inputChar) - 1].decision);
      return;
    }
    if (key.upArrow) {
      move((i) => i - 1);
      return;
    }
    if (key.downArrow) {
      move((i) => i + 1);
      return;
    }
    if (key.return) {
      pending.resolve(OPTIONS[selectedRef.current].decision);
      return;
    }
    if (key.escape) {
      pending.resolve('deny');
    }
  });

  if (!pending) return null;

  let args: Record<string, unknown> | null = null;
  try {
    args = JSON.parse(pending.call.function.arguments) as Record<string, unknown>;
  } catch {
    args = null;
  }
  const description = describeCall(pending.call.function.name, args, displayKind);
  const warning = dangerReason(pending.call.function.name, args, displayKind);
  // Dangerous calls must never be session-whitelisted silently: the
  // always option is simply not offered.
  const options = warning !== null ? OPTIONS.filter((o) => o.decision !== 'always') : OPTIONS;
  const effectiveSelected = Math.min(selected, options.length - 1);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={warning !== null ? 'red' : 'yellow'}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={warning !== null ? 'red' : 'yellow'}>Permission Required</Text>

      <Box marginTop={1}>
        <Text bold color="cyan">{pending.call.function.name}</Text>
        <Text color="white"> {description}</Text>
      </Box>

      {warning !== null && (
        <Box marginTop={0}>
          <Text color="red" bold>Warning: {warning}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={opt.key} paddingLeft={1}>
            <Text
              inverse={i === effectiveSelected}
              color={opt.decision === 'deny' ? 'red' : opt.decision === 'always' ? 'yellow' : 'green'}
              bold={i === effectiveSelected}
            >
              {opt.key}. {opt.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
