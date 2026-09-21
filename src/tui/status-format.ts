import { theme } from './theme.js';
import type { ModelCost } from '../llm/catalog.js';
import type { CacheStatsView } from './hooks/useAgent.js';

/**
 * Pure formatting helpers for the status footer (tui-refactor ticket 09):
 * compact token counts, session cost estimation from catalog prices,
 * context-window usage with warning colors, and the working-indicator
 * border color. Filesystem work (git branch) lives in `git-branch.ts`.
 */

export type { ModelCost };

/** Format tokens as a compact human-readable number (e.g. 12.3k). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Usage totals used for the cost/context segments. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimate the session cost in USD, or null when the model has no price.
 *
 * Normalized semantics: `inputTokens` INCLUDES cached and cache-write
 * tokens, so uncached input is billed at the input rate and the cached /
 * write portions at their own rates (falling back to the input rate when
 * the catalog omits them).
 */
/**
 * Session cost in USD. Rates are USD per 1M tokens as declared by the model
 * catalog (`cost` in models.json). Missing cache rates fall back to the input
 * rate; a model without a price yields null and the footer shows '—'.
 */
export function estimateCostUsd(usage: UsageTotals, cost: ModelCost | undefined): number | null {
  if (cost === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached - write);
  const cacheReadRate = cost.cacheRead ?? cost.input;
  const cacheWriteRate = cost.cacheWrite ?? cost.input;
  return (
    (uncached * cost.input +
      cached * cacheReadRate +
      write * cacheWriteRate +
      usage.outputTokens * cost.output) /
    1_000_000
  );
}

/** Context-usage percentage plus its warning color (theme token). */
export function contextUsage(
  tokens: number,
  contextWindow: number,
): { percent: number; color: string } {
  if (contextWindow <= 0) return { percent: 0, color: theme.muted };
  const percent = Math.min(100, Math.max(0, Math.round((tokens / contextWindow) * 100)));
  const color = percent >= 85 ? theme.error : percent >= 60 ? theme.warning : theme.muted;
  return { percent, color };
}

/** Editor border color as the working indicator (idle/streaming/thinking). */
export function workingBorderColor(state: 'idle' | 'streaming' | 'thinking'): string {
  // Single source: the theme's working palette (ticket 11).
  return theme.working[state];
}

/** Input for `/status` report composition (tui-redesign ticket 02). */
export interface StatusReportInput {
  providerName: string;
  model: string;
  thinkingLevel?: string;
  contextWindow?: number;
  contextStrategy?: 'truncate' | 'compact';
  cacheStats?: CacheStatsView;
  modelCost?: ModelCost;
  /** Extra pre-rendered lines (cwd/branch, MCP count, …). */
  extras?: string[];
}

/**
 * Compose the `/status` report: the info the retired top StatusBar used to
 * carry, as transcript text. One line per concern; usage line shows a
 * placeholder until the first request records tokens.
 */
export function formatStatusReport(input: StatusReportInput): string {
  const { providerName, model, thinkingLevel, contextWindow, contextStrategy, cacheStats, modelCost, extras } = input;
  const head =
    `${providerName}/${model} · thinking ${thinkingLevel ?? 'off'}` +
    (contextWindow ? ` · ctx ${contextWindow.toLocaleString('en-US')}` : '') +
    (contextStrategy ? ` (${contextStrategy})` : '');
  const hasUsage = (cacheStats?.totalInputTokens ?? 0) > 0 || (cacheStats?.totalOutputTokens ?? 0) > 0;
  let usage = 'usage: no requests recorded yet';
  if (cacheStats && hasUsage) {
    const cost = estimateCostUsd(
      {
        inputTokens: cacheStats.totalInputTokens,
        outputTokens: cacheStats.totalOutputTokens,
        cachedInputTokens: cacheStats.totalCachedTokens,
        cacheWriteTokens: cacheStats.totalCacheWriteTokens,
      },
      modelCost,
    );
    const cache =
      cacheStats.totalCachedTokens + cacheStats.totalCacheWriteTokens > 0
        ? ` · R${fmtTokens(cacheStats.totalCachedTokens)} W${fmtTokens(cacheStats.totalCacheWriteTokens)} CH${Math.round(cacheStats.latestHitRate * 100)}%`
        : '';
    usage =
      `usage: ↑${fmtTokens(cacheStats.totalInputTokens)} ↓${fmtTokens(cacheStats.totalOutputTokens)}${cache}` +
      ` · ${cost === null ? '—' : `$${cost.toFixed(4)}`}`;
  }
  return [head, ...(extras ?? []), usage].join('\n');
}
