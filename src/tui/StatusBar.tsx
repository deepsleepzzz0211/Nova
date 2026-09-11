import React from 'react';
import { Box, Text } from 'ink';
import {
  fmtTokens,
  estimateCostUsd,
  contextUsage,
  type ModelCost,
} from './status-format.js';

/** Props for the StatusBar component (pi-style three-segment footer). */
export interface StatusBarProps {
  /** Name of the active LLM model. */
  model: string;
  /** Current working directory. */
  workingDirectory: string;
  /** Git branch for the working directory (or null when not a repo). */
  gitBranch?: string | null;
  /** Provider name shown next to the model. */
  providerName?: string;
  /** Unified thinking level shown in the right segment. */
  thinkingLevel?: string;
  /** Number of active MCP server connections. */
  mcpConnectionCount: number;
  /** One-line update notice (or null when silent). */
  updateNotice?: string;
  /** Live subagent activity line (or null when idle). */
  subagentActivity?: string | null;
  /** Prompt-cache metrics and session token totals (pi-style R/W/CH). */
  cacheStats?: {
    hitRate: number;
    latestHitRate: number;
    totalCachedTokens: number;
    totalCacheWriteTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  /** Model pricing for the cost estimate (absent = shown as —). */
  modelCost?: ModelCost;
  /** Context window size for the usage percentage. */
  contextWindow?: number;
}

/**
 * Three-segment status footer (tui-refactor ticket 09, pi-style):
 * left = cwd + git branch, middle = tokens / cache / cost / context,
 * right = provider + model + thinking level. Notices and live subagent
 * activity render as a second line when present.
 */
export function StatusBar({
  model,
  workingDirectory,
  gitBranch,
  providerName,
  thinkingLevel,
  mcpConnectionCount,
  cacheStats,
  modelCost,
  contextWindow,
  updateNotice,
  subagentActivity,
}: StatusBarProps): React.ReactElement {
  const cost = cacheStats
    ? estimateCostUsd(
        {
          inputTokens: cacheStats.totalInputTokens,
          outputTokens: cacheStats.totalOutputTokens,
          cachedInputTokens: cacheStats.totalCachedTokens,
          cacheWriteTokens: cacheStats.totalCacheWriteTokens,
        },
        modelCost,
      )
    : null;

  const context = contextUsage(cacheStats?.totalInputTokens ?? 0, contextWindow ?? 0);

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        {/* Left: working directory + git branch */}
        <Box>
          <Text color="gray" dimColor>{workingDirectory}</Text>
          {gitBranch && <Text color="cyan"> ({gitBranch})</Text>}
          {mcpConnectionCount > 0 && (
            <Text color="gray" dimColor> · {mcpConnectionCount} MCP</Text>
          )}
        </Box>

        {/* Middle: tokens / cache / cost / context */}
        <Box>
          {cacheStats && (
            <>
              <Text color="green">{`↑${fmtTokens(cacheStats.totalInputTokens)} ↓${fmtTokens(cacheStats.totalOutputTokens)}`}</Text>
              {cacheStats.totalCachedTokens + cacheStats.totalCacheWriteTokens > 0 && (
                <Text color="gray">
                  {` R${fmtTokens(cacheStats.totalCachedTokens)} W${fmtTokens(cacheStats.totalCacheWriteTokens)} CH${Math.round(cacheStats.latestHitRate * 100)}%`}
                </Text>
              )}
              <Text color={context.color}>{` · ctx ${context.percent}%`}</Text>
              <Text color="gray">{` · ${cost === null ? '—' : `$${cost.toFixed(4)}`}`}</Text>
            </>
          )}
        </Box>

        {/* Right: provider + model + thinking */}
        <Box>
          <Text color="gray" dimColor>{providerName ? `${providerName}/` : ''}</Text>
          <Text bold color="cyan">{model}</Text>
          {thinkingLevel && <Text color="gray" dimColor>{` · ${thinkingLevel}`}</Text>}
        </Box>
      </Box>

      {subagentActivity && (
        <Box paddingX={1}>
          <Text color="magenta">{subagentActivity}</Text>
        </Box>
      )}
      {updateNotice && (
        <Box paddingX={1}>
          <Text color="yellow">{updateNotice}</Text>
        </Box>
      )}
    </Box>
  );
}
