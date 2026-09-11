import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { DisplayToolCall } from './display-types.js';
import {
  spinnerFrame,
  summarizeCall,
  foldLines,
  formatArgs,
  parseToolArgs,
  STATUS_STYLE,
  type DisplayKindResolver,
} from './tool-summary.js';

/** Props for the ToolCallView component. */
export interface ToolCallViewProps {
  /** The tool call to display. */
  toolCall: DisplayToolCall;
  /** Whether this block's details are expanded (Ctrl+O, App-controlled). */
  expanded: boolean;
  /** Registry-backed tool display kind resolver (command/path). */
  displayKind?: DisplayKindResolver;
}

/**
 * Presentational tool-call block (tui-refactor ticket 05): no local input
 * handling, no local fold state — App owns the expanded id (Ctrl+O toggles
 * the most recent block).
 *
 * Status: animated spinner (running), ⚠ (pending permission), ✓ (done),
 * ✗ (error). Folded by default to a one-line typed summary; expanded shows
 * the arguments and the (line-folded) result.
 */
function ToolCallViewImpl({ toolCall, expanded, displayKind }: ToolCallViewProps): React.ReactElement {
  const tick = useSpinnerTick(toolCall.status === 'running');

  const statusStyle = STATUS_STYLE[toolCall.status];
  const statusIcon = toolCall.status === 'running' ? spinnerFrame(tick) : statusStyle.icon;
  const statusColor = statusStyle.color;

  // Pretty args for the expanded view (compact summary is typed).
  const argsDisplay = formatArgs(toolCall.arguments, parseToolArgs(toolCall.arguments));

  const summary = summarizeCall(toolCall.name, toolCall.arguments, displayKind);

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text bold color="yellow">{toolCall.name}</Text>
        {!expanded && <Text color="gray" dimColor> {summary}</Text>}
      </Box>

      {expanded && (
        <Box flexDirection="column" paddingLeft={3}>
          <Text color="gray" dimColor>{argsDisplay}</Text>
        </Box>
      )}

      {toolCall.result !== undefined && expanded && (
        <Box flexDirection="column" paddingLeft={3} marginTop={0}>
          <Text color="gray">Result:</Text>
          <Text color={toolCall.status === 'error' ? 'red' : 'white'}>
            {foldLines(toolCall.result, 20).text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Ticks 80ms while active; frozen at 0 otherwise. */
function useSpinnerTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(timer);
  }, [active]);
  return active ? tick : 0;
}

/** Memoised tool block (tui-refactor ticket 08): only status/expansion changes. */
export const ToolCallView = React.memo(ToolCallViewImpl);
