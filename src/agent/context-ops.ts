import type { Message } from '../llm/types.js';
import type { SessionWriter } from './session.js';
import type { Compactor, CompactResult } from './compaction.js';
import { CompactionGuard } from './compaction-guard.js';
import { ContextManager } from './context.js';
import { microcompactMessages } from './microcompact.js';
import type { ContextDecisionReason, LoopContextConfig } from './loop-types.js';

/**
 * The context-management region of the agent loop (p1-p2 12, split out of
 * loop.ts): microcompact → summary → truncate chains, the pressure/suppress/
 * breaker guard bookkeeping, /compact (compactNow) and /undo (undoTurns).
 *
 * Messages live in the loop; this collaborator reads and rewrites them
 * through the injected accessors — same sequencing, same side effects, no
 * new state owners.
 */
export interface ContextOpsDeps {
  getMessages: () => Message[];
  setMessages: (messages: Message[]) => void;
  contextManager: ContextManager | null;
  contextStrategy: LoopContextConfig['strategy'] | null;
  compactor: Compactor | null;
  microcompactIdleMs: number;
  session: SessionWriter | null;
  onCompaction?: (info: {
    strategy: 'truncate' | 'compact' | 'microcompact';
    beforeTokens: number;
    afterTokens: number;
    reason: ContextDecisionReason;
  }) => void;
  onContextNote?: (note: string) => void;
}

export class ContextOps {
  private readonly deps: ContextOpsDeps;
  private readonly guard = new CompactionGuard();
  private lastActivityAtMs: number;

  constructor(deps: ContextOpsDeps) {
    this.deps = deps;
    this.lastActivityAtMs = Date.now();
  }

  /**
   * Layer 0 (zcode-borrow 01): run the zero-LLM microcompact pass; when it
   * applies, swap, persist, report, and return the new token count.
   */
  private runMicrocompact(currentTokens: number, reason: ContextDecisionReason): number {
    const { contextManager, getMessages, setMessages, session, onCompaction } = this.deps;
    if (!contextManager) return currentTokens;
    const messages = getMessages();
    const micro = microcompactMessages(messages, {
      countTokens: (text) => contextManager?.countText(text) ?? 0,
    });
    if (!micro.applied) return currentTokens;
    const afterTokens = contextManager.countTokens(micro.messages);
    setMessages(micro.messages);
    void session?.appendCompaction(micro.messages);
    onCompaction?.({ strategy: 'microcompact', beforeTokens: currentTokens, afterTokens, reason });
    return afterTokens;
  }

  /**
   * Guard bookkeeping for one summarization attempt, shared by the automatic
   * chain and the manual/overflow path: counts failures toward the circuit
   * (announcing when the attempt OPENS it) and resets the failure streak on
   * a wire-level success. The rapid-refill anchor is NOT set here — only
   * where a pass is actually applied (a grown summary gets discarded below
   * and must not count as an applied compaction).
   */
  private noteSummaryOutcome(
    result: CompactResult | null,
  ): { outcome: 'applied'; messages: Message[] } | { outcome: 'failed' | 'nothing' } {
    if (result === null) {
      if (this.guard.recordFailure()) {
        this.deps.onContextNote?.(
          `compaction circuit breaker opened: summary failed ${this.guard.failureThreshold} times in a row, truncating without summarizing for the rest of the session`,
        );
      }
      return { outcome: 'failed' };
    }
    if (result.method === 'none') {
      return { outcome: 'nothing' };
    }
    this.guard.recordSuccess();
    return { outcome: 'applied', messages: result.messages };
  }

  /** Run a truncate/compact pass when the conversation approaches the budget. */
  async prepareContext(): Promise<void> {
    const { contextManager, contextStrategy, getMessages, setMessages, compactor, onCompaction, onContextNote } = this.deps;
    if (!contextManager || !contextStrategy) return;

    this.guard.nextRound();
    const nowMs = Date.now();
    const idleElapsed = nowMs - this.lastActivityAtMs >= this.deps.microcompactIdleMs;
    this.lastActivityAtMs = nowMs;

    // Microcompact fires on token pressure OR long idle; when it alone fits
    // the budget we stop, otherwise the compact → truncate chain continues
    // on the cleared messages.
    let tokens = contextManager.countTokens(getMessages());
    if (idleElapsed || contextManager.isNearLimit(tokens)) {
      tokens = this.runMicrocompact(tokens, idleElapsed ? 'idle' : 'pressure');
    }
    if (!contextManager.isNearLimit(tokens)) return;

    const beforeTokens = tokens;

    // Rapid refill (pressure back on the tail of the last pass): repeated
    // occurrences silence the automatic chain — overflow recovery and
    // /compact still bypass it (zcode-borrow ticket 02).
    const pressure = this.guard.notePressure();
    if (pressure.suppressedNow) {
      onContextNote?.(
        `rapid refill detected: context hit the limit again within ${this.guard.refillWindowRounds} rounds of each of the last ${this.guard.refillStreakLimit} compactions; automatic compaction is off for this session (use /compact if needed)`,
      );
    }
    if (this.guard.compactSuppressed) return;

    // Fallback chain: compact → truncate. A failed summary must still
    // shrink the context; fail-open here would hit the window on the
    // very next round. "Nothing to summarize" is NOT a failure — keep
    // the messages as-is (e.g. a single huge user message). Once the
    // summary circuit has opened, passes go straight to truncate.
    let after: Message[] | null = null;
    let applied: LoopContextConfig['strategy'] = contextStrategy;
    if (contextStrategy === 'compact' && compactor && !this.guard.circuitOpen) {
      const attempt = this.noteSummaryOutcome(await compactor.compact(getMessages()));
      if (attempt.outcome === 'applied') {
        after = attempt.messages; // summary or placeholder pass
      } else if (attempt.outcome === 'nothing') {
        return; // nothing to compact — no compaction possible
      } else {
        applied = 'truncate';
      }
    }
    if (after === null) {
      // Pressure watermark: trim to triggerTokens, not maxTokens — a pass
      // targeting max reclaims nothing inside the [trigger, max) dead band
      // and re-fires every round (truncate-idle 01). Matches the manual /
      // overflow paths and shadow-replay, which already trim below trigger.
      after = contextManager.truncateToTokens(getMessages(), contextManager.triggerTokens);
    }

    const afterTokens = contextManager.countTokens(after);
    // A pass that did not actually shrink the context rewrites nothing and
    // reports nothing (the /status compaction counter stays honest).
    if (afterTokens >= beforeTokens) return;
    setMessages(after);
    this.guard.noteCompactionApplied();
    void this.deps.session?.appendCompaction(after);
    onCompaction?.({ strategy: applied, beforeTokens, afterTokens, reason: 'pressure' });
  }

  /**
   * Undo the last N conversation turns (a turn = one user message and
   * everything after it until the next user message). Conversation-only:
   * file changes made by tools are NOT reverted (use git for those).
   * Persistence stays append-only: the post-undo state is written as a
   * checkpoint, which --resume replays as the truncated history.
   * N is clamped to the number of available turns.
   */
  undoTurns(n = 1): { undone: boolean; undoneTurns: number } {
    const messages = this.deps.getMessages();
    const userIdxs: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') userIdxs.push(i);
    }
    if (userIdxs.length === 0 || n < 1) {
      return { undone: false, undoneTurns: 0 };
    }

    const undoneTurns = Math.min(n, userIdxs.length);
    const cut = undoneTurns === userIdxs.length ? 0 : userIdxs[userIdxs.length - undoneTurns];
    const after = messages.slice(0, cut);
    this.deps.setMessages(after);
    void this.deps.session?.appendCompaction(after); // append-only checkpoint; replay truncates
    return { undone: true, undoneTurns };
  }

  /**
   * Force a compaction/truncation pass regardless of the token trigger.
   * Origins: the /compact command ('manual') and reactive overflow recovery
   * ('overflow') — both bypass the automatic-path gates.
   */
  async compactNow(origin: 'manual' | 'overflow' = 'manual'): Promise<{
    compacted: boolean;
    strategy?: 'truncate' | 'compact';
    beforeTokens?: number;
    afterTokens?: number;
  }> {
    const { contextManager, contextStrategy, getMessages, setMessages, compactor, onCompaction } = this.deps;
    if (!contextManager || !contextStrategy) {
      return { compacted: false };
    }

    // Manual/overflow path also gets the free layer first: microcompact, then
    // summary/truncate on whatever pressure remains. It bypasses the
    // automatic-path gates (breaker, suppression) by design — an explicit
    // request or a real overflow deserves the attempt — but still feeds the
    // guard so repeated failures eventually open the circuit for auto too.
    const beforeTokens = this.runMicrocompact(
      contextManager.countTokens(getMessages()),
      origin,
    );

    let after: Message[] | null = null;
    if (compactor) {
      const attempt = this.noteSummaryOutcome(await compactor.compact(getMessages()));
      if (attempt.outcome === 'applied') {
        after = attempt.messages; // summary or placeholder pass
      } else if (attempt.outcome === 'nothing') {
        // Nothing to summarize (e.g. all user messages): nothing to do
        return { compacted: false, strategy: contextStrategy, beforeTokens };
      } else {
        // Summary failed → degrade to an aggressive truncate
        after = contextManager.truncateToTokens(
          getMessages(),
          Math.floor(contextManager.triggerTokens / 2),
        );
      }
    }
    if (after === null) {
      // Manual truncate target: half the trigger budget (aggressive cleanup)
      after = contextManager.truncateToTokens(
        getMessages(),
        Math.floor(contextManager.triggerTokens / 2),
      );
    }

    const afterTokens = contextManager.countTokens(after);
    // Compaction is meaningful only when it actually shrank the context
    // (the summary can outweigh toy-size summarized content).
    if (afterTokens >= beforeTokens) {
      return { compacted: false, strategy: contextStrategy, beforeTokens };
    }
    setMessages(after);
    this.guard.noteCompactionApplied();
    void this.deps.session?.appendCompaction(after);
    onCompaction?.({
      strategy: contextStrategy,
      beforeTokens,
      afterTokens,
      reason: origin,
    });
    return { compacted: true, strategy: contextStrategy, beforeTokens, afterTokens };
  }
}
