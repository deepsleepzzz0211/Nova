import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { DisplayToolCall } from './display-types.js';
import { buildDiffView, foldDiff, type DiffLine } from './diff-view.js';
import { truncateToWidth } from './text-measure.js';
import {
  spinnerFrame,
  summarizeCall,
  foldLines,
  formatArgs,
  parseToolArgs,
  toolVerb,
  formatDurationMs,
  STATUS_STYLE,
  type DisplayKindResolver,
  type ToolRow,
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
  // Diff rows must fit the terminal minus the block's left padding
  // (tui-redesign 08: no overflow past the last column).
  const { stdout } = useStdout();
  const diffRowWidth = Math.max(20, (stdout.columns ?? 80) - 3);

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
  const durationMs =
    toolCall.startedAtMs !== undefined && toolCall.endedAtMs !== undefined
      ? Math.max(0, toolCall.endedAtMs - toolCall.startedAtMs)
      : null;

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Box>
        <Text color={statusColor} bold>{`${statusIcon} ${toolVerb(toolCall.name)}`}</Text>
        {!expanded && summary !== '' && (
          <Text color={theme.muted} dimColor> {summary}</Text>
        )}
        {!expanded && durationMs !== null && (
          <Text color={theme.muted} dimColor>{` ${formatDurationMs(durationMs)}`}</Text>
        )}
      </Box>

      {expanded && diffView !== null && (
        <Box flexDirection="column" paddingLeft={3}>
          <Text color={theme.diffHeader} dimColor>{diffView.header}</Text>
          {folded.lines.map((line, i) => (
            <DiffLineRow key={i} line={line} width={diffRowWidth} />
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

/** Folded same-verb count row: `✓ Read ×3 (latest src/a.ts)` (tui-redesign 05). */
export function ToolGroupRow({ group }: { group: Extract<ToolRow, { type: 'group' }> }): React.ReactElement {
  const style = STATUS_STYLE[group.status];
  return (
    <Box paddingLeft={2}>
      <Text color={style.color} bold>{`${style.icon} ${group.verb} ×${group.count}`}</Text>
      {group.latestSummary !== '' && (
        <Text color={theme.muted} dimColor>{` (latest ${group.latestSummary})`}</Text>
      )}
    </Box>
  );
}

/** One diff row: 4-wide number gutter, marker, text on a full-line bg. */
function DiffLineRow({ line, width }: { line: DiffLine; width: number }): React.ReactElement {
  const no = line.oldNo ?? line.newNo;
  const gutter = `${String(no ?? '').padStart(4)} `;
  const marker = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '';
  const body = truncateToWidth(line.text, Math.max(8, width - gutter.length - marker.length), '...');
  const fg =
    line.kind === 'add' ? theme.diffAdded : line.kind === 'del' ? theme.diffRemoved : theme.diffContext;
  const bg =
    line.kind === 'add' ? theme.diffAddedBg : line.kind === 'del' ? theme.diffRemovedBg : undefined;
  return (
    <Box width="100%" backgroundColor={bg}>
      <Text color={fg}>
        {line.kind === 'meta' ? line.text : `${gutter}${marker}${body}`}
      </Text>
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
