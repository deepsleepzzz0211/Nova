import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingPermission } from './hooks/useAgent.js';
import type { PermissionDecision } from './permission-display.js';
import { describeCall, dangerReason } from './permission-display.js';
import { parseToolArgs, type DisplayKindResolver } from './tool-summary.js';
import { theme } from './theme.js';
import { TitledFrame } from './TitledFrame.js';

/** Props for the PermissionDialog component. */
export interface PermissionDialogProps {
  /** The pending permission request, or null if none. */
  pending: PendingPermission | null;
  /** Registry-backed tool display kind resolver (command/path). */
  displayKind?: DisplayKindResolver;
}

/** Options shown, in display order (option 3 is excluded for dangerous calls). */
const OPTIONS: Array<{ key: '1' | '2' | '3'; label: string; decision: PermissionDecision }> = [
  { key: '1', label: 'Deny', decision: 'deny' },
  { key: '2', label: 'Allow once', decision: 'allow' },
  { key: '3', label: 'Allow always (this session)', decision: 'always' },
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
  // Derived display data computed before the hooks (pure values, no hooks):
  // the filtered option list is what the key handler and the view share, so
  // a hidden option can never be selected by number or by arrows.
  const parsedArgs = pending === null ? null : parseToolArgs(pending.call.function.arguments);
  const warning = pending !== null ? dangerReason(pending.call.function.name, parsedArgs, displayKind) : null;
  const options = warning !== null ? OPTIONS.filter((o) => o.decision !== 'always') : OPTIONS;

  // Rules of hooks: all hooks run unconditionally; the early return below
  // comes AFTER all hooks (tui-refactor ticket 01).
  const [selected, setSelected] = useState(0);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  // Ref mirror: key events can burst before React re-renders (lessons.md #9).
  const selectedRef = useRef(0);
  // A new request must not inherit the previous selection (review: the
  // stale "3. Yes, always" highlight could auto-approve the next call).
  useEffect(() => {
    selectedRef.current = 0;
    setSelected(0);
  }, [pending]);
  const move = (fn: (i: number) => number, length: number): void => {
    const next = Math.max(0, Math.min(length - 1, fn(selectedRef.current)));
    selectedRef.current = next;
    setSelected(next);
  };
  useInput((inputChar, key) => {
    if (!pending) return;
    // Route keys through the FILTERED option list: option 3 does not exist
    // for dangerous calls, so '3' / Down-Down+Enter must not resolve
    // 'always' behind the user's back (review finding).
    const available = optionsRef.current;
    if (inputChar >= '1' && inputChar <= '9') {
      const picked = available[Number(inputChar) - 1];
      if (picked) pending.resolve(picked.decision);
      return;
    }
    if (key.upArrow) {
      move((i) => i - 1, available.length);
      return;
    }
    if (key.downArrow) {
      move((i) => i + 1, available.length);
      return;
    }
    if (key.return) {
      pending.resolve(available[selectedRef.current].decision);
      return;
    }
    if (key.escape) {
      pending.resolve('deny');
    }
  });

  if (!pending) return null;

  const description = describeCall(pending.call.function.name, parsedArgs, displayKind);
  const effectiveSelected = Math.min(selected, options.length - 1);

  return (
    <TitledFrame
      title={`${warning !== null ? '⛔' : '⚠'} Approval — ${pending.call.function.name}`}
      color={warning !== null ? theme.error : theme.warning}
      marginY={1}
    >
      {/* Reason first: why the agent is blocked right here (dangerReason for
          dangerous calls, generic explanation otherwise). */}
      <Text color={warning !== null ? theme.error : theme.muted} dimColor={warning === null} bold={warning !== null}>
        {warning ?? 'this action needs your confirmation before running'}
      </Text>

      <Box>
        <Text bold color={theme.primary}>{pending.call.function.name}</Text>
        <Text color={theme.assistantMessage}> {description}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={opt.key} paddingLeft={1}>
            <Text
              inverse={i === effectiveSelected}
              color={opt.decision === 'deny' ? theme.error : opt.decision === 'always' ? theme.warning : theme.success}
              bold={i === effectiveSelected}
            >
              {`${i === effectiveSelected ? '> ' : '  '}${opt.key}. ${opt.label}`}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.muted} dimColor>{'1/2/3 or ↑/↓ · Enter confirm · Esc deny'}</Text>
    </TitledFrame>
  );
}
