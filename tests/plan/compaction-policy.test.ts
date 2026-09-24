import { describe, it, expect } from 'vitest';
import { CompactionGuard } from '../../src/agent/compaction-guard.js';
import { ContextManager } from '../../src/agent/context.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

/**
 * Ticket zcode-borrow 02 — compaction policy hardening: effective-window
 * trigger, reason-coded decisions, circuit breaker after repeated summary
 * failures, and rapid-refill thrash suppression.
 */

describe('ContextManager effective window', () => {
  it('subtracts the output reserve capped at 21K plus the fixed safety buffer', () => {
    // Default reserve 16384 (< 21K cap) + 13000 buffer = 29384 total.
    const cm = new ContextManager({ model: 'm', maxTokens: 128_000 });
    expect(cm.triggerTokens).toBe(128_000 - 29_384);
    expect(cm.isNearLimit(128_000 - 29_384)).toBe(true);
    expect(cm.isNearLimit(128_000 - 29_385)).toBe(false);
  });

  it('caps an oversized configured output reserve at 21K', () => {
    const cm = new ContextManager({ model: 'm', maxTokens: 200_000, reserveTokens: 50_000 });
    // min(50000, 21000) + 13000 = 34000; below the half-window clamp (100000)
    expect(cm.triggerTokens).toBe(200_000 - 34_000);
  });

  it('clamps total reserve to half the window (tiny windows unchanged)', () => {
    const tiny = new ContextManager({ model: 'm', maxTokens: 100 });
    expect(tiny.triggerTokens).toBe(50);
  });

  it('safety buffer is configurable', () => {
    const cm = new ContextManager({ model: 'm', maxTokens: 100_000, safetyBufferTokens: 0 });
    expect(cm.triggerTokens).toBe(100_000 - 16_384);
  });
});

describe('CompactionGuard', () => {
  it('opens the circuit after 3 consecutive failures; opening is sticky', () => {
    const g = new CompactionGuard();
    expect(g.recordFailure()).toBe(false);
    expect(g.recordFailure()).toBe(false);
    expect(g.recordFailure()).toBe(true); // third opens it
    expect(g.circuitOpen).toBe(true);
    g.recordSuccess();
    expect(g.circuitOpen).toBe(true); // session-scoped: no auto-close
  });

  it('a success resets the consecutive failure count', () => {
    const g = new CompactionGuard();
    g.recordFailure();
    g.recordFailure();
    g.recordSuccess();
    g.recordFailure();
    g.recordFailure();
    expect(g.circuitOpen).toBe(false);
  });

  it('detects rapid refill and suppresses after the streak limit', () => {
    const g = new CompactionGuard({ refillWindowRounds: 2, refillStreakLimit: 2 });
    g.nextRound(); // r1
    g.noteCompactionApplied(); // compacted during r1
    g.nextRound(); // r2
    expect(g.notePressure().suppressedNow).toBe(false); // first refill: not yet
    expect(g.compactSuppressed).toBe(false);
    g.noteCompactionApplied();
    g.nextRound(); // r3, within 2 rounds of r2
    expect(g.notePressure().suppressedNow).toBe(true); // streak of 2 trips it
    expect(g.compactSuppressed).toBe(true);
  });

  it('a clean gap resets the refill streak', () => {
    const g = new CompactionGuard({ refillWindowRounds: 2, refillStreakLimit: 2 });
    g.noteCompactionApplied(); // r0
    g.nextRound();
    g.nextRound();
    g.nextRound(); // r3: outside the window
    expect(g.notePressure().suppressedNow).toBe(false);
    g.noteCompactionApplied();
    g.nextRound();
    expect(g.compactSuppressed).toBe(false); // streak restarted at 1
  });

  it('notices interpolate the configured thresholds, not baked-in numbers', () => {
    const g = new CompactionGuard({ failureThreshold: 5, refillWindowRounds: 4, refillStreakLimit: 3 });
    expect(g.failureThreshold).toBe(5);
    expect(g.refillWindowRounds).toBe(4);
    expect(g.refillStreakLimit).toBe(3);
  });
});

// --- loop wiring --------------------------------------------------------------

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function fatBody(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `filler ${i}: plain english sentence body`).join('\n');
}

interface Counts {
  main: number;
  summary: number;
}

/** Summary requests (compaction) carry no systemPrompt option; main turns do. */
function makeLLM(summary: 'fail' | 'ok'): { llm: LLMProvider; counts: Counts } {
  const counts: Counts = { main: 0, summary: 0 };
  const llm: LLMProvider = {
    async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      if (opts.systemPrompt === undefined) {
        counts.summary++;
        if (summary === 'fail') {
          yield { type: 'error', error: 'summary endpoint exploded' };
        } else {
          yield { type: 'text_delta', content: 'SUMMARY TEXT' };
        }
        return;
      }
      counts.main++;
      yield { type: 'text_delta', content: 'ok' };
    },
  };
  return { llm, counts };
}

function seedHistory(): Message[] {
  // Huge user messages are kept verbatim by the compactor, so pressure
  // returns immediately after every compaction (rapid-refill material).
  return [
    { role: 'user', content: fatBody(300) },
    { role: 'assistant', content: fatBody(300) },
    { role: 'user', content: fatBody(300) },
    { role: 'assistant', content: fatBody(300) },
  ];
}

function makeLoop(
  llm: LLMProvider,
  extra: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {},
) {
  return new AgentLoop({
    llm,
    toolRegistry: new ToolRegistry(),
    toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
    config: { maxToolRounds: 3, model: 'test' },
    context: { maxTokens: 4000, reserveTokens: 1000, keepRecentTokens: 300, strategy: 'compact' },
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPermissionRequest: async () => true,
    ...extra,
  });
}

describe('AgentLoop compaction policy', () => {
  it('circuit-breaks after 3 summary failures: later turns skip the summary attempt', async () => {
    const notes: string[] = [];
    const { llm, counts } = makeLLM('fail');
    const loop = makeLoop(llm, { onContextNote: (n) => notes.push(n) });
    loop.loadMessages(seedHistory());

    // Fat turns spaced by two light turns: an applied pass anchors the
    // rapid-refill window (truncate-idle 01 made every applied pass anchor),
    // so back-to-back pressure would exercise the refill suppression instead
    // of the breaker. Spacing pressure > the 2-round window isolates the
    // circuit-breaker path this test is about.
    for (let turn = 0; turn < 7; turn++) {
      if (turn % 3 === 0) loop.loadMessages(seedHistory());
      await loop.processUserInput(
        turn % 3 === 0 ? 'keep going ' + turn : 'short ' + turn,
      );
    }
    expect(counts.summary).toBe(3); // breaker stopped further attempts
    expect(counts.main).toBe(7); // the conversation itself kept working
    expect(notes.some((n) => /circuit/i.test(n))).toBe(true);
  });

  it('suppresses compaction when the context rapidly refills after each pass', async () => {
    const notes: string[] = [];
    const events: Array<{ strategy: string; reason?: string }> = [];
    const { llm, counts } = makeLLM('ok');
    const loop = makeLoop(llm, {
      onContextNote: (n) => notes.push(n),
      onCompaction: (i) => events.push({ strategy: i.strategy, reason: i.reason }),
    });
    loop.loadMessages(seedHistory());

    for (let turn = 0; turn < 5; turn++) {
      await loop.processUserInput('refill ' + turn);
    }
    // Pressure stays (huge kept user messages): after 2 rapid refills the
    // automatic chain goes quiet while the conversation continues.
    expect(counts.main).toBe(5);
    expect(counts.summary).toBeLessThan(5);
    expect(notes.some((n) => /rapid/i.test(n))).toBe(true);
  });

  it('manual/overflow failures also announce when they open the circuit', async () => {
    const notes: string[] = [];
    const { llm } = makeLLM('fail');
    const loop = makeLoop(llm, { onContextNote: (n) => notes.push(n) });
    // Re-seed before each call: a failed compactNow truncates the context,
    // and an already-slim context has nothing to summarize (no attempt, no
    // failure counted). Fresh fat history keeps every call a real attempt.
    for (let i = 0; i < 2; i++) {
      loop.loadMessages(seedHistory());
      await loop.compactNow('overflow');
    }
    expect(notes).toHaveLength(0);
    loop.loadMessages(seedHistory());
    await loop.compactNow('overflow'); // third failure opens it
    expect(notes.some((n) => /circuit/i.test(n))).toBe(true);
  });

  it('onCompaction events carry the decision reason', async () => {
    const events: Array<{ strategy: string; reason?: string }> = [];
    const { llm } = makeLLM('ok');
    const loop = makeLoop(llm, { onCompaction: (i) => events.push({ strategy: i.strategy, reason: i.reason }) });
    loop.loadMessages(seedHistory());
    await loop.processUserInput('go');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.reason === 'string')).toBe(true);
    expect(events.some((e) => e.reason === 'pressure')).toBe(true);
  });

  it('manual compactNow reports reason manual', async () => {
    const events: Array<{ strategy: string; reason?: string }> = [];
    const { llm } = makeLLM('ok');
    const loop = makeLoop(llm, { onCompaction: (i) => events.push({ strategy: i.strategy, reason: i.reason }) });
    loop.loadMessages(seedHistory());
    await loop.compactNow();
    expect(events.some((e) => e.reason === 'manual')).toBe(true);
  });
});

describe('grown summary is discarded (truncate-idle 01 review)', () => {
  it('a summary larger than the context is never applied, persisted, or counted', async () => {
    const events: Array<{ strategy: string; beforeTokens: number; afterTokens: number }> = [];
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.systemPrompt === undefined) {
          // "successful" summary that is bigger than everything it replaces.
          yield { type: 'text_delta', content: fatBody(600) };
          return;
        }
        yield { type: 'text_delta', content: 'ok' };
      },
    };
    const loop = makeLoop(llm, { onCompaction: (i) => events.push(i) });
    const seeded = seedHistory();
    loop.loadMessages(seeded);
    await loop.processUserInput('word '.repeat(300)); // push past the trigger
    for (const e of events) {
      expect(e.afterTokens).toBeLessThan(e.beforeTokens);
    }
    // The grown summary must not have replaced the seeded history.
    const now = loop.getMessages();
    expect(now.some((m) => typeof m.content === 'string' && m.content.includes('filler 599'))).toBe(false);
  });
});
