import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message } from '../../src/llm/types.js';
import { SessionStore } from '../../src/agent/session.js';
import {
  createExtractionScheduler,
  type ExtractionSnapshot,
  type MemoryExtractor,
} from '../../src/memory/extraction-scheduler.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

/**
 * memory-v2 ticket 04: the extraction scheduler MECHANICS only. The executor
 * is an injected stub here — ticket 05 hangs the real memory subagent on the
 * same seam. Snapshot shape and skip rules mirror the ZCode design doc in the
 * ticket: cursor only advances; direct memory writes and prose-less windows
 * skip; one execution at a time; shutdown drains with a bounded budget.
 */

const u = (content: string): Message => ({ role: 'user', content });
const asst = (toolName?: string, args?: string): Message =>
  toolName
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c-${toolName}-${Math.random()}`, type: 'function', function: { name: toolName, arguments: args ?? '{}' } }],
      }
    : { role: 'assistant', content: 'ok' };
const tool = (id: string, content: string): Message => ({ role: 'tool', tool_call_id: id, content });

const USER_PROSE = u('please remember the deploy rule for later sessions');

function snap(messages: Message[], overrides: Partial<ExtractionSnapshot> = {}): ExtractionSnapshot {
  return {
    messages,
    memoryDirs: ['/home/.nova/memory', '/proj/.nova/memory'],
    workingDirectory: '/proj',
    ...overrides,
  };
}

function recorder() {
  const calls: { snapshot: ExtractionSnapshot; window: readonly Message[] }[] = [];
  const extract: MemoryExtractor = async (snapshot, window) => {
    calls.push({ snapshot, window });
    return 'success';
  };
  return { calls, extract };
}

function makeScheduler(overrides: Partial<Parameters<typeof createExtractionScheduler>[0]> = {}) {
  const rec = recorder();
  const persisted: number[] = [];
  const scheduler = createExtractionScheduler({
    enabled: true,
    extract: rec.extract,
    persistCursor: (c) => persisted.push(c),
    ...overrides,
  });
  return { ...rec, persisted, scheduler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('extraction scheduler (ticket 04 mechanics)', () => {
  it('disabled scheduler: zero side effects — snapshot never built, extract never called', async () => {
    let built = 0;
    const { scheduler, calls } = makeScheduler({
      enabled: false,
      extract: async () => 'success',
    });
    scheduler.schedule(() => {
      built += 1;
      return snap([USER_PROSE, asst()]);
    });
    await scheduler.drain();
    expect(built).toBe(0);
    expect(calls).toHaveLength(0);
    expect(scheduler.getCursor()).toBe(0);
    expect(scheduler.hasPendingWork()).toBe(false);
  });

  it('enabled: extracts the window since the cursor and advances it (only forward)', async () => {
    const { scheduler, calls, persisted } = makeScheduler();
    scheduler.schedule(() => snap([USER_PROSE, asst(), tool('c1', 'x')]));
    await scheduler.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0].window).toHaveLength(3);
    expect(scheduler.getCursor()).toBe(3);
    expect(persisted).toEqual([3]);

    // Next turn: only the NEW messages travel in the window.
    const more = [USER_PROSE, asst(), tool('c1', 'x'), u('and the rollback order matters too here'), asst()];
    scheduler.schedule(() => snap(more));
    await scheduler.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1].window).toHaveLength(2);
    expect(scheduler.getCursor()).toBe(5);
  });

  it('skip rule: a direct memory_write in the window skips extraction but advances the cursor', async () => {
    const { scheduler, calls } = makeScheduler();
    scheduler.schedule(() => snap([USER_PROSE, asst('memory_write', '{"name":"a","fact":"b"}'), tool('c', 'Remembered')]));
    await scheduler.drain();
    expect(calls).toHaveLength(0);
    expect(scheduler.getCursor()).toBe(3);
  });

  it('skip rule: a write_file/edit_file INTO a memory dir counts as a direct write', async () => {
    const { scheduler, calls } = makeScheduler();
    scheduler.schedule(() =>
      snap([USER_PROSE, asst('write_file', JSON.stringify({ path: '/proj/.nova/memory/notes.md', content: 'x' })), tool('c', 'wrote')]),
    );
    await scheduler.drain();
    expect(calls).toHaveLength(0);

    // A write OUTSIDE the memory dirs must NOT trigger the skip.
    scheduler.schedule(() =>
      snap([
        USER_PROSE,
        asst('write_file', JSON.stringify({ path: '/proj/.nova/memory/notes.md', content: 'x' })),
        tool('c', 'wrote'),
        u('and a fresh long user question arrives'),
        asst('write_file', JSON.stringify({ path: '/proj/src/a.ts', content: 'x' })),
        tool('c2', 'wrote'),
      ]),
    );
    await scheduler.drain();
    expect(calls).toHaveLength(1);
  });

  it('skip rule: no user prose (or too-short) in the window skips', async () => {
    const { scheduler, calls } = makeScheduler();
    scheduler.schedule(() => snap([asst(), tool('c', 'output')]));
    await scheduler.drain();
    expect(calls).toHaveLength(0);

    scheduler.schedule(() => snap([asst(), tool('c', 'output'), u('hi'), asst()]));
    await scheduler.drain();
    expect(calls).toHaveLength(0);
    expect(scheduler.getCursor()).toBe(4);
  });

  it('executor failure does NOT advance the cursor (window grows next time)', async () => {
    const { scheduler, persisted } = makeScheduler({ extract: async () => 'error' });
    scheduler.schedule(() => snap([USER_PROSE, asst()]));
    await scheduler.drain();
    expect(scheduler.getCursor()).toBe(0);
    expect(persisted).toEqual([]);
  });

  it('single-flight: concurrent schedules coalesce to the latest snapshot, never run in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];
    let release: () => void = () => undefined;
    const firstGate = new Promise<void>((r) => (release = r));
    const scheduler = createExtractionScheduler({
      enabled: true,
      extract: async (_snap, window) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(window.length);
        if (seen.length === 1) await firstGate;
        inFlight -= 1;
        return 'success';
      },
    });
    scheduler.schedule(() => snap([USER_PROSE, asst()])); // starts, gated
    scheduler.schedule(() => snap([USER_PROSE, asst(), u('second turn question about things'), asst()])); // pending
    scheduler.schedule(() => snap([USER_PROSE, asst(), u('third turn question about things'), asst(), u('fourth more text here'), asst()])); // replaces pending
    release();
    await scheduler.drain();
    expect(maxInFlight).toBe(1);
    // first ran, then only the LATEST pending (6 msgs − cursor 2 = 4-msg
    // window; the middle snapshot was superseded, never executed)
    expect(seen).toEqual([2, 4]);
    expect(scheduler.getCursor()).toBe(6);
  });

  it('rewind: cursor clamps to the truncated branch; old messages are never re-extracted', async () => {
    const { scheduler, calls } = makeScheduler();
    const five = [USER_PROSE, asst(), tool('c', 'x'), u('another long user sentence here'), asst()];
    scheduler.schedule(() => snap(five));
    await scheduler.drain();
    expect(scheduler.getCursor()).toBe(5);

    // /undo truncates to 3, then a new user turn appends two messages.
    scheduler.onRewind(3);
    const after = [five[0], five[1], five[2], u('rewritten question entirely here'), asst()];
    scheduler.schedule(() => snap(after));
    await scheduler.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1].window).toHaveLength(2); // only the post-rewind pair
    expect(calls[1].window[0]).toBe(after[3]);
    expect(scheduler.getCursor()).toBe(5);
  });

  it('defensive: a snapshot SHORTER than the cursor clamps without re-extracting (missed onRewind)', async () => {
    const { scheduler, calls } = makeScheduler();
    scheduler.schedule(() => snap([USER_PROSE, asst(), u('one more long user line'), asst()]));
    await scheduler.drain();
    expect(scheduler.getCursor()).toBe(4);

    scheduler.schedule(() => snap([USER_PROSE, asst()])); // branch shrank, no onRewind call
    await scheduler.drain();
    expect(calls).toHaveLength(1); // nothing new extracted
    expect(scheduler.getCursor()).toBe(2);
  });

  it('shutdown: bounded drain — a hung executor is abandoned once the budget elapses', async () => {
    vi.useFakeTimers();
    const scheduler = createExtractionScheduler({
      enabled: true,
      drainBudgetMs: 5_000,
      extract: () => new Promise(() => undefined), // never settles
    });
    scheduler.schedule(() => snap([USER_PROSE, asst()]));
    await vi.waitFor(() => expect(scheduler.hasPendingWork()).toBe(true));

    const closed = scheduler.shutdown();
    let done = false;
    void closed.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(done).toBe(false); // still inside the budget
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true); // budget elapsed: drop it
    await closed;
    expect(scheduler.hasPendingWork()).toBe(false);

    // Post-shutdown schedules are dead letters.
    const before = scheduler.getCursor();
    scheduler.schedule(() => snap([USER_PROSE, asst(), u('late message text here'), asst()]));
    expect(scheduler.getCursor()).toBe(before);
  });

  it('initialCursor resumes from persisted session metadata', async () => {
    const { scheduler, calls } = makeScheduler({ initialCursor: 3 });
    scheduler.schedule(() => snap([USER_PROSE, asst(), tool('c', 'x'), u('fresh user question about stuff'), asst()]));
    await scheduler.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0].window).toHaveLength(2);
  });
});

describe('memory.extractionEnabled config (ticket 04 switch)', () => {
  it('ships DEFAULT-OFF: extraction never runs until proven on real machines', () => {
    expect(DEFAULT_CONFIG.memory.extractionEnabled).toBe(false);
  });
});

describe('extraction cursor in session metadata (ticket 04 persistence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-cursor-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('SessionStore.load skips memory-cursor lines; loadMemoryCursor returns the LAST stored index', () => {
    const file = path.join(dir, 'session-x.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: 'hello there friend' }),
      JSON.stringify({ type: 'memory-cursor', index: 3 }),
      JSON.stringify({ role: 'assistant', content: 'ok' }),
      JSON.stringify({ type: 'memory-cursor', index: 4 }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    const replayed = SessionStore.load(file);
    expect(replayed).toHaveLength(2);
    expect(replayed.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(SessionStore.loadMemoryCursor(file)).toBe(4);
  });

  it('absent cursor (fresh or unreadable session) yields undefined', () => {
    expect(SessionStore.loadMemoryCursor(path.join(dir, 'missing.jsonl'))).toBeUndefined();
    const file = path.join(dir, 'no-cursor.jsonl');
    fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'x' }) + '\n', 'utf-8');
    expect(SessionStore.loadMemoryCursor(file)).toBeUndefined();
  });
});
