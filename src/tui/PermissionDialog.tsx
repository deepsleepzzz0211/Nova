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
  if (!pending) return null;

  const { call, resolve } = pending;
  const toolName = call.function.name;

  // Parse parameters for display
  let paramsDisplay: string;
  try {
    const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>;
    paramsDisplay = JSON.stringify(parsed, null, 2);
  } catch {
    paramsDisplay = call.function.arguments;
  }

  // Check for danger reasons
  const dangerReason = getDangerReason(toolName, call.function.arguments);

  useInput((inputChar, key) => {
    if (inputChar === 'a') {
      resolve(true);
    } else if (inputChar === 'd') {
      resolve(false);
    } else if (inputChar === 'A') {
      // "Always Allow" — resolve as allowed (the permission policy
      // would need to be updated for persistent always-allow, but
      // for this session we allow it)
      resolve(true);
    }
  });

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
function getDangerReason(toolName: string, argsString: string): string | null {
  if (toolName !== 'bash') return null;

  let command: string;
  try {
    const params = JSON.parse(argsString) as Record<string, unknown>;
    command = typeof params.command === 'string' ? params.command : '';
  } catch {
    return null;
  }

  if (!command) return null;

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }

  return null;
}
