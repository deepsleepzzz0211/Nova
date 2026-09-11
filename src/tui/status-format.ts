import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pure formatting helpers for the status footer (tui-refactor ticket 09):
 * compact token counts, session cost estimation from catalog prices,
 * context-window usage with warning colors, and git branch detection.
 */

/** Format tokens as a compact human-readable number (e.g. 12.3k). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Model pricing, USD per 1M tokens (as declared in models.json). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
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

/** Context-usage percentage plus its warning color. */
export function contextUsage(
  tokens: number,
  contextWindow: number,
): { percent: number; color: 'gray' | 'yellow' | 'red' } {
  if (contextWindow <= 0) return { percent: 0, color: 'gray' };
  const percent = Math.min(100, Math.max(0, Math.round((tokens / contextWindow) * 100)));
  const color = percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'gray';
  return { percent, color };
}

/**
 * Current git branch for `dir`, a short sha for a detached HEAD, or null
 * when `dir` is not a repository. Reads .git/HEAD only (no subprocess).
 */
export function readGitBranch(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf-8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1];
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 8);
    return null;
  } catch {
    return null;
  }
}
