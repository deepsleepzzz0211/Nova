import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingPermission } from './hooks/useAgent.js';
import { DANGEROUS_PATTERNS } from '../permission/dangerous.js';

/** Props for the PermissionDialog component. */
export interface PermissionDialogProps {
  /** The pending permission request, or null if none. */
  pending: PendingPermission | null;
}

/**
 * Modal overlay for permission requests.
 *
 * Shows: tool name, parameters, danger reason (if any).
 * Three buttons: [Allow (a)] [Deny (d)] [Always Allow (A)]
 */
export function PermissionDialog({ pending }: PermissionDialogProps): React.ReactElement | null {
  // Rules of hooks: all hooks must run unconditionally on every render —
  // the early return below comes AFTER all hooks. Registering useInput
  // conditionally (only when `pending` is non-null) changed the hook order
  // between renders and could crash or misbehave when a permission request
  // appears/disappears.
  useInput((inputChar) => {
    if (!pending) return;
    if (inputChar === 'a') {
      pending.resolve(true);
    } else if (inputChar === 'd') {
      pending.resolve(false);
    } else if (inputChar === 'A') {
      // "Always Allow" — resolve as allowed (the permission policy
      // would need to be updated for persistent always-allow, but
      // for this session we allow it)
      pending.resolve(true);
    }
  });

  if (!pending) return null;

  const { call, resolve } = pending;
  const toolName = call.function.name;

  // Parse parameters once for display and danger detection
  let paramsDisplay: string;
  let parsedArgs: Record<string, unknown> | null = null;
  try {
    parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>;
    paramsDisplay = JSON.stringify(parsedArgs, null, 2);
  } catch {
    paramsDisplay = call.function.arguments;
  }

  // Check for danger reasons
  const dangerReason = getDangerReason(toolName, parsedArgs);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">Permission Required</Text>

      <Box marginTop={1}>
        <Text color="white">Tool: </Text>
        <Text bold color="cyan">{toolName}</Text>
      </Box>

      {dangerReason !== null && (
        <Box marginTop={0}>
          <Text color="red">Warning: {dangerReason}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>Parameters:</Text>
        <Text color="white">{paramsDisplay}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="green" bold>[Allow (a)] </Text>
        <Text color="red" bold>[Deny (d)] </Text>
        <Text color="yellow" bold>[Always Allow (A)]</Text>
      </Box>
    </Box>
  );
}

/**
 * Check if a tool call matches any dangerous patterns and return the reason.
 * Returns null if no danger is detected.
 */
function getDangerReason(toolName: string, args: Record<string, unknown> | null): string | null {
  if (toolName !== 'bash' || args === null) return null;

  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return null;

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }

  return null;
}
