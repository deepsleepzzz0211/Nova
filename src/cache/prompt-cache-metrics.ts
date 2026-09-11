/** Per-turn usage reported by providers (normalized). */
export interface TurnUsage {
  /** Total prompt tokens, INCLUDING cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Tracks provider prompt-cache usage across a session (pi-style R/W/CH
 * footer metrics): total cache-read (R), cache-write (W) tokens and the
 * cache hit rate (CH).
 *
 * Hit rate = cached input / total input (input already includes cached and
 * cache-write tokens under the normalized semantics).
 */
export class PromptCacheMetrics {
  private totalInput = 0;
  private totalCached = 0;
  private totalWrite = 0;
  private totalOutput = 0;
  private lastRate = 0;
  private lastInput = 0;

  /** Record one turn's usage (sums are the caller's responsibility). */
  record(usage: TurnUsage): void {
    const cached = usage.cachedInputTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    this.totalInput += usage.inputTokens;
    this.totalCached += cached;
    this.totalWrite += write;
    this.totalOutput += usage.outputTokens;
    this.lastRate = usage.inputTokens > 0 ? cached / usage.inputTokens : 0;
    // Prompt size of the most recent request ~= current context usage
    // (the session total grows monotonically and is useless as a gauge).
    this.lastInput = usage.inputTokens;
  }

  /** Total input tokens seen (including cached and cache-write). */
  get totalInputTokens(): number {
    return this.totalInput;
  }

  /** Cache read (R): prompt tokens served from cache. */
  get totalCachedTokens(): number {
    return this.totalCached;
  }

  /** Prompt tokens of the most recent request (current context size). */
  get lastInputTokens(): number {
    return this.lastInput;
  }

  /** Cache write (W): prompt tokens written to the cache. */
  get totalCacheWriteTokens(): number {
    return this.totalWrite;
  }

  /** Total output tokens. */
  get totalOutputTokens(): number {
    return this.totalOutput;
  }

  /** Session-wide cache hit rate (CH). */
  get hitRate(): number {
    return this.totalInput > 0 ? this.totalCached / this.totalInput : 0;
  }

  /** Cache hit rate of the most recent recorded turn. */
  get latestHitRate(): number {
    return this.lastRate;
  }
}
