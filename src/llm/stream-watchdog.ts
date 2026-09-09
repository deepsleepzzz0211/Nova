/**
 * Stream stall watchdog (streaming ticket 01).
 *
 * Providers and proxies occasionally stop emitting bytes mid-stream — the
 * promise neither resolves nor rejects and the turn hangs forever. This
 * wrapper races every next() against an idle timer that resets on each
 * chunk, so a stalled stream fails cleanly while slow-but-alive streams
 * (e.g. long thinking before the first token) are unaffected.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleTimeoutMs: number,
  onStall: () => Error,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await raceWithTimeout(iterator.next(), idleTimeoutMs, onStall);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Propagate early consumer exit (break/return/throw) to the source.
    // Fire-and-forget: awaiting return() would hang if the source is
    // suspended at a never-settling await (the exact stall we guard).
    void iterator.return?.().catch(() => {});
  }
}

function raceWithTimeout<T>(
  promise: Promise<IteratorResult<T>>,
  timeoutMs: number,
  onStall: () => Error,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onStall()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


/** Thrown when a stream is interrupted via its abort signal. */
export class StreamInterruptedError extends Error {
  constructor() {
    super('LLM stream interrupted');
    this.name = 'StreamInterruptedError';
  }
}

/**
 * Consume `source` (already watchdog-wrapped) to completion, yielding each
 * chunk to `onChunk` as it arrives, but bail out with
 * StreamInterruptedError as soon as `signal` aborts. The source is
 * abandoned on interruption (a partially-read stream cannot be drained).
 */
export async function consumeWithInterrupt<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  onChunk: (chunk: T) => void,
): Promise<void> {
  if (signal?.aborted) throw new StreamInterruptedError();
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new StreamInterruptedError()), { once: true });
      })
    : new Promise<never>(() => {}); // never settles when no signal

  let iterator: AsyncIterator<T> | undefined;
  const run = (async () => {
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      const result = await iterator.next();
      if (result.done) return;
      onChunk(result.value);
    }
  })();

  try {
    await Promise.race([run, abortPromise]);
  } finally {
    // Abandon the source on interruption (a partially-read stream cannot
    // be drained); normal completion already ended it.
    void iterator?.return?.().catch(() => {});
  }
}
