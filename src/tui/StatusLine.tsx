import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { spinnerFrame } from './tool-summary.js';
import { fmtTokens, estimateCostUsd, contextUsage, type ModelCost } from './status-format.js';
import { modeBadge, type ApprovalModeId } from './approval-mode.js';
import type { CacheStatsView } from './hooks/useAgent.js';

/** Props for the StatusLine component (tui-redesign ticket 02). */
export interface StatusLineProps {
  /** Working indicator; anything but idle animates the left side. */
  working: 'idle' | 'streaming' | 'thinking';
  /** Prompt-cache metrics and session token totals (R/W/CH badges). */
  cacheStats?: CacheStatsView;
  /** Model pricing for the cost estimate (absent = shown as —). */
  modelCost?: ModelCost;
  /** Context window size for the usage percentage. */
  contextWindow?: number;
  /** One-line update notice (or undefined when silent). */
  updateNotice?: string;
  /** Live subagent activity line (or null when idle). */
  subagentActivity?: string | null;
  /** Active approval mode; renders the Shift+Tab badge (tui-redesign 10). */
  approvalMode?: ApprovalModeId;
  /** Transient toast text replacing the badge right after a mode switch. */
  modeToast?: string | null;
}

/**
 * Bottom status line under the input (tui-redesign ticket 02): replaces the
 * old top StatusBar. Left = braille spinner + "esc to interrupt" while the
 * agent works; right = token flow, cache hit-rate badge, context-usage badge
 * and session cost. Collapses to nothing when there is no signal to show.
 */
export function StatusLine({
  working,
  cacheStats,
  modelCost,
  contextWindow,
  updateNotice,
  subagentActivity,
  approvalMode,
  modeToast,
}: StatusLineProps): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (working === 'idle') return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 80);
    return () => {
      clearInterval(timer);
    };
  }, [working]);

  const hasUsage =
    (cacheStats?.totalInputTokens ?? 0) > 0 || (cacheStats?.totalOutputTokens ?? 0) > 0;
  const hasBadge = approvalMode !== undefined || (modeToast ?? null) !== null;
  if (working === 'idle' && !hasUsage && !hasBadge && !updateNotice && !subagentActivity) {
    return <></>;
  }

  const cost =
    cacheStats && hasUsage
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
  const context = cacheStats
    ? contextUsage(
        cacheStats.contextTokens,
        cacheStats.contextTriggerTokens ?? contextWindow ?? 0,
      )
    : null;

  return (
    <Box flexDirection="column">
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
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          {modeToast != null ? (
            <Text color={theme.primary} bold>{`${modeToast} (shift+tab)`}</Text>
          ) : (
            approvalMode !== undefined &&
            (() => {
              const badge = modeBadge(approvalMode);
              return (
                <Text color={badge.color} dimColor={approvalMode === 'default'}>
                  {`${badge.symbol} ${badge.label} · shift+tab`}
                </Text>
              );
            })()
          )}
          {working !== 'idle' && (
            <>
              {approvalMode !== undefined || modeToast != null ? <Text>{'  '}</Text> : null}
              <Text color={theme.primary}>
                {`${spinnerFrame(tick)} ${working === 'thinking' ? 'Thinking…' : 'Responding…'}`}
              </Text>
              <Text color={theme.muted} dimColor>{' · esc to interrupt'}</Text>
            </>
          )}
        </Box>
        <Box>
          {hasUsage && cacheStats && (
            <>
              <Text color={theme.success}>
                {`↑${fmtTokens(cacheStats.totalInputTokens)} ↓${fmtTokens(cacheStats.totalOutputTokens)}`}
              </Text>
              {cacheStats.totalCachedTokens + cacheStats.totalCacheWriteTokens > 0 && (
                <Text color={theme.muted}>
                  {` · R${fmtTokens(cacheStats.totalCachedTokens)} W${fmtTokens(cacheStats.totalCacheWriteTokens)} CH${Math.round(cacheStats.latestHitRate * 100)}%`}
                </Text>
              )}
              {context && (
                <Text color={context.color}>
                  {` · ${fmtTokens(cacheStats.contextTokens)} (${context.percent}%)${context.percent >= 85 ? ' ⚠' : ''}`}
                </Text>
              )}
              <Text color={theme.muted}>{` · ${cost === null ? '—' : `$${cost.toFixed(4)}`}`}</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}
