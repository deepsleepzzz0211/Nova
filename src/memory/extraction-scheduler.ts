import type { Message } from '../llm/types.js';

/**
 * Background memory-extraction scheduler (memory-v2 ticket 04; the mechanics
 * of the ZCode extraction design).
 *
 * After each normal turn the host `schedule()`s a snapshot of the ACTIVE
 * BRANCH (the live message array). A cursor (index into that array) marks
 * everything already considered; it only advances. Branch surgery — /undo
 * truncation or a compaction checkpoint — shrinks the branch: `onRewind()`
 * clamps the cursor to the new length (and a snapshot shorter than the
 * cursor clamps defensively even if the hook is missed), so messages that
 * were already considered are never re-extracted. Two skip rules protect the
 * direct path: the user already wrote memory this window (memory_write, or a
 * write/edit into a memory tree), or the window holds no real user prose.
 * Execution is single-flight — while one extraction runs, the newest pending
 * snapshot replaces the older queued one, never two at once. `shutdown()`
 * stops intake and drains with a bounded budget: past the budget the hung
 * executor is simply abandoned (memory is best-effort; the exit path must
 * not wait on it).
 *
 * The executor is INJECTED (ticket 05 hangs the real memory subagent here);
 * `memory.extractionEnabled` gates the whole pipeline and ships OFF, so a
 * disabled session pays literally nothing — the snapshot thunk is not even
 * called.
 */

/** Everything the scheduler may look at for one extraction round. */
export interface ExtractionSnapshot {
  /** The active branch, oldest first — the live array from the loop. */
  messages: readonly Message[];
  /** Memory trees (user + project dirs): direct writes here skip extraction. */
  memoryDirs: string[];
  workingDirectory: string;
}

/** Executor outcome: success/no-op advance the cursor; error does not. */
export type ExtractionStatus = 'success' | 'no-op' | 'error';

/** The injectable executor seam (ticket 05's hook point). */
export type MemoryExtractor = (
  snapshot: ExtractionSnapshot,
  window: readonly Message[],
) => Promise<ExtractionStatus>;

export interface ExtractionSchedulerOptions {
  enabled: boolean;
  extract: MemoryExtractor;
  /** Cursor restored from session metadata (resume); default 0. */
  initialCursor?: number;
  /** Persist the moved cursor (session metadata write); may be omitted. */
  persistCursor?: (cursor: number) => void;
  /** shutdown() abandons a hung executor after this budget. */
  drainBudgetMs?: number;
  /** A user message needs this many words to count as prose. Default 3. */
  minUserWords?: number;
}

export interface ExtractionScheduler {
  /** Fire-and-forget one turn-end schedule; the thunk is read lazily. */
  schedule(snapshot: () => ExtractionSnapshot): void;
  /** Tell the scheduler the branch just shrank (/undo, compaction). */
  onRewind(lengthAfterRewind: number): void;
  getCursor(): number;
  hasPendingWork(): boolean;
  /** Await the running chain (no budget) — for tests and graceful paths. */
  drain(): Promise<void>;
  /** Stop intake, drop pending, bounded-drain the in-flight run. */
  shutdown(): Promise<void>;
}

const DEFAULT_DRAIN_BUDGET_MS = 60_000;
const DEFAULT_MIN_USER_WORDS = 3;

function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

/**
 * Is this text real user prose? Word count for spaced scripts; a character
 * mass floor for spaceless ones (CJK sentences have no whitespace, and a
 * full Chinese requirement would otherwise score one "word" and be skipped).
 */
function isUserProse(text: string, minWords: number): boolean {
  return countWords(text) >= minWords || text.replace(/\s+/gu, '').length >= 12;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Does this window contain a DIRECT memory write? memory_write always; a
 * write_file/edit_file only when its `path` lands inside one of the memory
 * trees (relative paths resolved against the snapshot's working directory).
 */
function containsDirectMemoryWrite(window: readonly Message[], snapshot: ExtractionSnapshot): boolean {
  for (const message of window) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      const name = call.function.name;
      if (name === 'memory_write') return true;
      if (name !== 'write_file' && name !== 'edit_file') continue;
      let rawPath: unknown;
      try {
        rawPath = (JSON.parse(call.function.arguments || '{}') as { path?: unknown }).path;
      } catch {
        continue; // unparseable args: not evidence of a memory write
      }
      if (typeof rawPath !== 'string' || !rawPath) continue;
      const resolved = normalizeSlashes(
        rawPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizeSlashes(rawPath))
          ? rawPath
          : `${snapshot.workingDirectory}/${rawPath}`,
      );
      if (snapshot.memoryDirs.some((dir) => resolved.startsWith(`${normalizeSlashes(dir)}/`))) return true;
    }
  }
  return false;
}

function containsUserProse(window: readonly Message[], minWords: number): boolean {
  return window.some(
    (m) => m.role === 'user' && typeof m.content === 'string' && isUserProse(m.content, minWords),
  );
}

export function createExtractionScheduler(options: ExtractionSchedulerOptions): ExtractionScheduler {
  const { enabled, extract, persistCursor, minUserWords = DEFAULT_MIN_USER_WORDS } = options;
  const drainBudgetMs = options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS;

  let cursor = options.initialCursor ?? 0;
  let running: Promise<void> | undefined;
  let latestPending: (() => ExtractionSnapshot) | undefined;
  let intakeClosed = false;
  let abandoned = false;

  const advance = (to: number): void => {
    if (to > cursor) {
      cursor = to;
      persistCursor?.(cursor);
    }
  };

  const processSnapshot = async (build: () => ExtractionSnapshot): Promise<void> => {
    if (abandoned) return;
    let snapshot: ExtractionSnapshot;
    try {
      snapshot = build();
    } catch {
      return; // snapshot vanished (loop torn down): no-op, cursor untouched
    }
    const length = snapshot.messages.length;
    if (length < cursor) {
      // Branch shrank without an onRewind call: clamp so nothing old re-enters.
      cursor = length;
      return;
    }
    const window = snapshot.messages.slice(cursor);
    if (window.length === 0) return;
    if (containsDirectMemoryWrite(window, snapshot) || !containsUserProse(window, minUserWords)) {
      advance(length); // considered and deliberately skipped
      return;
    }
    let status: ExtractionStatus;
    try {
      status = await extract(snapshot, window);
    } catch {
      return; // failed extraction does NOT advance the cursor; retry next turn
    }
    if (!abandoned && (status === 'success' || status === 'no-op')) advance(length);
  };

  const run = async (first: () => ExtractionSnapshot): Promise<void> => {
    try {
      let current: (() => ExtractionSnapshot) | undefined = first;
      while (current && !abandoned) {
        await processSnapshot(current);
        current = latestPending;
        latestPending = undefined;
      }
    } finally {
      running = undefined;
    }
  };

  return {
    schedule(build) {
      if (!enabled || intakeClosed) return; // disabled: zero side effects, thunk never read
      if (running) {
        latestPending = build; // single-flight coalesce: newest replaces
        return;
      }
      running = run(build);
    },
    onRewind(lengthAfterRewind) {
      if (lengthAfterRewind < cursor) {
        cursor = lengthAfterRewind;
        persistCursor?.(cursor);
      }
    },
    getCursor: () => cursor,
    hasPendingWork: () => !abandoned && (running !== undefined || latestPending !== undefined),
    async drain() {
      while (running) {
        await running;
      }
    },
    async shutdown() {
      // Close intake, then DRAIN what is already queued (a one-shot print
      // session must still get its extraction). Past the budget an executor
      // that never settles is abandoned — memory is best-effort and the exit
      // path must not hang on it.
      intakeClosed = true;
      const work = running ?? Promise.resolve();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          abandoned = true;
          resolve();
        }, drainBudgetMs);
        void work.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
