/**
 * Compaction policy guard (zcode-borrow ticket 02): session-scoped state for
 * the automatic compaction chain. Two protections against thrash:
 *  - circuit breaker: N consecutive summary failures stop further LLM
 *    summarization for the session (truncation keeps working);
 *  - rapid-refill detection: when pressure returns within a few rounds of a
 *    compaction repeatedly, the automatic chain goes quiet (reactive
 *    overflow and manual /compact still bypass it).
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_REFILL_WINDOW_ROUNDS = 2;
const DEFAULT_REFILL_STREAK_LIMIT = 2;

/** Options for {@link CompactionGuard}. */
export interface CompactionGuardOptions {
  /** Consecutive summary failures before the circuit opens. Default 3. */
  failureThreshold?: number;
  /** Rounds after a compaction that count as a "rapid refill". Default 2. */
  refillWindowRounds?: number;
  /** Rapid refills in a row before the automatic chain is suppressed. Default 2. */
  refillStreakLimit?: number;
}

/** Outcome of a pressure observation. */
export interface PressureOutcome {
  /** True on the observation that flipped suppression on (announce once). */
  suppressedNow: boolean;
}

export class CompactionGuard {
  readonly failureThreshold: number;
  readonly refillWindowRounds: number;
  readonly refillStreakLimit: number;

  private failures = 0;
  private open = false;
  private round = 0;
  private lastAppliedRound: number | null = null;
  private refillStreak = 0;
  private suppressed = false;

  constructor(options: CompactionGuardOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.refillWindowRounds = options.refillWindowRounds ?? DEFAULT_REFILL_WINDOW_ROUNDS;
    this.refillStreakLimit = options.refillStreakLimit ?? DEFAULT_REFILL_STREAK_LIMIT;
  }

  /** True once the summary circuit has opened (sticky for the session). */
  get circuitOpen(): boolean {
    return this.open;
  }

  /** True once rapid refills suppressed the automatic chain (sticky). */
  get compactSuppressed(): boolean {
    return this.suppressed;
  }

  /** Advance the round counter; call once per context-management pass. */
  nextRound(): void {
    this.round++;
  }

  /** Record a summary failure. Returns true when this opened the circuit. */
  recordFailure(): boolean {
    this.failures++;
    if (!this.open && this.failures >= this.failureThreshold) {
      this.open = true;
      return true;
    }
    return false;
  }

  /** A successful summary resets the consecutive failure count. */
  recordSuccess(): void {
    this.failures = 0;
  }

  /** Call after a compaction pass was applied this round. */
  noteCompactionApplied(): void {
    this.lastAppliedRound = this.round;
  }

  /**
   * Observe token pressure; tracks rapid-refill suppression. Failures are
   * counted per attempt, not per round: an automatic pass and a later
   * overflow retry are two genuine LLM failures.
   */
  notePressure(): PressureOutcome {
    const rapid =
      this.lastAppliedRound !== null &&
      this.round - this.lastAppliedRound <= this.refillWindowRounds;
    let suppressedNow = false;
    if (rapid) {
      this.refillStreak++;
      if (this.refillStreak >= this.refillStreakLimit && !this.suppressed) {
        this.suppressed = true;
        suppressedNow = true;
      }
    } else {
      this.refillStreak = 0;
    }
    return { suppressedNow };
  }
}
