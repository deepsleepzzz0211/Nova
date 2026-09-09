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
