import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { CacheStatsView } from './hooks/useAgent.js';
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
  cacheStats?: CacheStatsView;
  /** Model pricing for the cost estimate (absent = shown as —). */
  modelCost?: ModelCost;
  /** Context window size for the usage percentage. */
  contextWindow?: number;
  /** Context management strategy shown next to the usage. */
  contextStrategy?: 'truncate' | 'compact';
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
  contextStrategy,
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

  const hasUsage = (cacheStats?.totalInputTokens ?? 0) > 0 || (cacheStats?.totalOutputTokens ?? 0) > 0;
  // Current context size = prompt size of the most recent request (the
  // session total grows monotonically and would saturate the gauge).
  const context = contextUsage(
    cacheStats?.contextTokens ?? 0,
    cacheStats?.contextTriggerTokens ?? contextWindow ?? 0,
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
        {/* Left: working directory + git branch */}
        <Box>
          <Text color={theme.muted} dimColor>{workingDirectory}</Text>
          {gitBranch && <Text color={theme.primary}> ({gitBranch})</Text>}
          {mcpConnectionCount > 0 && (
            <Text color={theme.muted} dimColor> · {mcpConnectionCount} MCP</Text>
          )}
        </Box>

        {/* Middle: tokens / cache / cost / context */}
        <Box>
          {cacheStats && (
            <>
              <Text color={theme.success}>{`↑${fmtTokens(cacheStats.totalInputTokens)} ↓${fmtTokens(cacheStats.totalOutputTokens)}`}</Text>
              {cacheStats.totalCachedTokens + cacheStats.totalCacheWriteTokens > 0 && (
                <Text color={theme.muted}>
                  {` R${fmtTokens(cacheStats.totalCachedTokens)} W${fmtTokens(cacheStats.totalCacheWriteTokens)} CH${Math.round(cacheStats.latestHitRate * 100)}%`}
                </Text>
              )}
              <Text color={context.color}>
                {` · ctx ${context.percent}%${contextWindow ? `/${fmtTokens(contextWindow)}` : ''}${context.percent >= 85 ? ' ⚠' : ''}`}
              </Text>
              {contextStrategy && <Text color={theme.muted} dimColor>{` (${contextStrategy})`}</Text>}
              <Text color={theme.muted}>{` · ${cost === null || !hasUsage ? '—' : `$${cost.toFixed(4)}`}`}</Text>
              <Text color={theme.muted} dimColor>{'  '}</Text>
            </>
          )}
        </Box>

        {/* Right: provider + model + thinking */}
        <Box>
          {providerName && (
            <Text color={theme.muted} dimColor>{`${providerName}/`}</Text>
          )}
          <Text bold color={theme.primary}>{model}</Text>
          {thinkingLevel && <Text color={theme.muted} dimColor>{` · ${thinkingLevel}`}</Text>}
        </Box>
      </Box>

      {subagentActivity && (
        <Box paddingX={1}>
          <Text color={theme.secondary}>{subagentActivity}</Text>
        </Box>
      )}
      {updateNotice && (
        <Box paddingX={1}>
          <Text color={theme.warning}>{updateNotice}</Text>
        </Box>
      )}
    </Box>
  );
}
