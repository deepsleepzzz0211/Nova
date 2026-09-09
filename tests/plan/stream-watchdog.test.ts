/** Stream stall watchdog (ticket 01): idle-timeout race over stream consumption. */
import { describe, it, expect } from 'vitest';
import { withIdleTimeout } from '../../src/llm/stream-watchdog.js';
import type { StreamChunk } from '../../src/llm/types.js';

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

async function* chunksOf(...contents: string[]): AsyncGenerator<StreamChunk> {
  for (const content of contents) yield { type: 'text_delta', content };
}

function never(): AsyncGenerator<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {}); // never resolves
    },
  } as AsyncGenerator<StreamChunk>;
}

describe('withIdleTimeout (ticket 01)', () => {
  it('passes chunks through when each arrives within the idle window', async () => {
    const chunks = await collect(
      withIdleTimeout(chunksOf('a', 'b', 'c'), 1000, () => new Error('stalled')),
    );
    expect(chunks.map((c) => (c as { content: string }).content)).toEqual(['a', 'b', 'c']);
  });

  it('errors when the stream stalls beyond the idle window', async () => {
    await expect(
      collect(withIdleTimeout(never(), 50, () => new Error('LLM stream stalled'))),
    ).rejects.toThrow('LLM stream stalled');
  });

  it('resets the idle timer on every chunk (intermittent slow streams survive)', async () => {
    // three chunks, each 60ms apart, window 100ms — total 180ms > window but
    // no single gap exceeds it
    const slow = (async function* () {
      for (const c of ['x', 'y', 'z']) {
        await new Promise((r) => setTimeout(r, 60));
        yield { type: 'text_delta', content: c } as StreamChunk;
      }
    })();
    const chunks = await collect(withIdleTimeout(slow, 100, () => new Error('stalled')));
    expect(chunks).toHaveLength(3);
  });

  it('cleans up the underlying iterator when the consumer exits early', async () => {
    let finallyRan = false;
    async function* src(): AsyncGenerator<StreamChunk> {
      try {
        yield { type: 'text_delta', content: 'a' };
        yield { type: 'text_delta', content: 'b' };
      } finally {
        finallyRan = true;
      }
    }
    const out: StreamChunk[] = [];
    for await (const c of withIdleTimeout(src(), 1000, () => new Error('stalled'))) {
      out.push(c);
      break; // consumer exits after the first chunk
    }
    expect(out).toHaveLength(1);
    // allow the async cleanup to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(finallyRan).toBe(true);
  });
});
