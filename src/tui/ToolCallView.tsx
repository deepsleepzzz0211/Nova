import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { DisplayToolCall } from './display-types.js';
import { buildDiffView, foldDiff, type DiffLine } from './diff-view.js';
import {
  spinnerFrame,
  summarizeCall,
  foldLines,
  formatArgs,
  parseToolArgs,
  STATUS_STYLE,
  type DisplayKindResolver,
} from './tool-summary.js';
import { theme } from './theme.js';

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
  const parsedArgs = parseToolArgs(toolCall.arguments);
  const argsDisplay = formatArgs(toolCall.arguments, parsedArgs);
  // edit/write calls render a line-level diff instead of raw JSON (ticket 06);
  // the mode comes from the tool's registry declaration, not from its name.
  const diffMode = displayKind?.(toolCall.name)?.diff;
  const diffView = diffMode !== undefined ? buildDiffView(parsedArgs, diffMode) : null;
  const folded = diffView !== null ? foldDiff(diffView) : { lines: [], hidden: 0 };

  const summary = summarizeCall(toolCall.name, toolCall.arguments, displayKind);

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text bold color={theme.toolTitle}>{toolCall.name}</Text>
        {!expanded && <Text color={theme.muted} dimColor> {summary}</Text>}
      </Box>

      {expanded && diffView !== null && (
        <Box flexDirection="column" paddingLeft={3}>
          <Text color={theme.diffHeader} dimColor>{diffView.header}</Text>
          {folded.lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
          {folded.hidden > 0 && (
            <Text color={theme.muted} dimColor>{`... (${folded.hidden} more diff lines)`}</Text>
          )}
        </Box>
      )}

      {expanded && diffView === null && (
        <Box flexDirection="column" paddingLeft={3}>
          <Text color={theme.toolOutput} dimColor>{argsDisplay}</Text>
        </Box>
      )}

      {toolCall.result !== undefined && expanded && (
        <Box flexDirection="column" paddingLeft={3} marginTop={0}>
          <Text color={theme.muted}>Result:</Text>
          <Text color={toolCall.status === 'error' ? theme.toolError : theme.toolOutput}>
            {foldLines(toolCall.result, 20).text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** One diff row: additions green, removals red, wrapped but never truncated. */
function DiffLineRow({ line }: { line: DiffLine }): React.ReactElement {
  if (line.kind === 'add') {
    return (
      <Box>
        <Text color={theme.diffAdded}>{`+ `}</Text>
        <Text color={theme.diffAdded}>{line.text}</Text>
      </Box>
    );
  }
  if (line.kind === 'del') {
    return (
      <Box>
        <Text color={theme.diffRemoved}>{`- `}</Text>
        <Text color={theme.diffRemoved}>{line.text}</Text>
      </Box>
    );
  }
  return <Text color={theme.diffContext} dimColor>{line.text}</Text>;
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
