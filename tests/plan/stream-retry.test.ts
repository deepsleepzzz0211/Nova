import { describe, it, expect } from 'vitest';
import {
  createProvider,
  createAssistantMessageEventStream,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createPiaiEngine, type PiaiEngine } from '../../src/llm/piai-engine.js';
import { PiProvider } from '../../src/llm/providers/piai.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';

/**
 * Ticket zcode-borrow 03 — stream-retry-boundary. A stream that dies inside
 * the "safe prelude" (no real text emitted, no completed tool batch) is
 * retried transparently; after the boundary the old error-chunk semantics
 * stand. These tests script raw pi-ai event streams so the mid-tool-call
 * cutoff is exact.
 */

const FLAKY_MODEL: Model<string> = {
  id: 'flaky-llm',
  name: 'flaky-llm',
  api: 'flaky-api',
  provider: 'flaky',
  reasoning: false,
  input: ['text'],
  contextWindow: 32_768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function basePartial(): AssistantMessage {
  return fauxAssistantMessage('');
}

function errorEvent(reason: 'error' | 'aborted', message = 'boom'): AssistantMessageEvent {
  return {
    type: 'error',
    reason,
    error: fauxAssistantMessage('', { stopReason: 'error', errorMessage: message }),
  } as AssistantMessageEvent;
}

/** Events for a partial tool call: start with id/name, one arg fragment. */
function stalledToolCallEvents(): AssistantMessageEvent[] {
  const partial = { ...basePartial(), content: [fauxToolCall('read_file', {}, { id: 'c1' })] };
  return [
    { type: 'start', partial: basePartial() },
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"path:', partial },
  ];
}

/** Events for the completed tool call used by the successful attempt. */
function fullToolCallEvents(): AssistantMessageEvent[] {
  const toolCall = fauxToolCall('read_file', { path: 'e2e.txt' }, { id: 'c1' });
  const partial = { ...basePartial(), content: [toolCall] };
  const done = fauxAssistantMessage([toolCall], { stopReason: 'toolUse' });
  return [
    { type: 'start', partial: basePartial() },
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"e2e.txt"}', partial },
    { type: 'toolcall_end', contentIndex: 0, toolCall, partial },
    { type: 'done', reason: 'toolUse', message: done },
  ];
}

function scriptedStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  const last = events[events.length - 1];
  if (last && (last.type === 'done' || last.type === 'error')) {
    stream.end(last.type === 'done' ? last.message : last.error);
  }
  return stream;
}

function makeFlakyEngine(
  attemptsFor: (attempt: number) => AssistantMessageEvent[],
): { engine: PiaiEngine; attempts: () => number } {
  let count = 0;
  const api = {
    stream: (_model: Model<string>, _context: Context, _options?: SimpleStreamOptions) => {
      count++;
      return scriptedStream(attemptsFor(count));
    },
    streamSimple: (_model: Model<string>, _context: Context, _options?: SimpleStreamOptions) => {
      count++;
      return scriptedStream(attemptsFor(count));
    },
  };
  const engine = createPiaiEngine();
  engine.models.setProvider(
    createProvider({
      id: 'flaky',
      auth: { apiKey: envApiKeyAuth('Flaky', ['FLAKY_API_KEY']) },
      models: [FLAKY_MODEL],
      api,
    }),
  );
  return { engine, attempts: () => count };
}

function makeProvider(engine: PiaiEngine, maxStreamRetries?: number): PiProvider {
  return new PiProvider({
    engine,
    provider: 'flaky',
    model: FLAKY_MODEL.id,
    apiKey: 'k',
    ...(maxStreamRetries === undefined ? {} : { maxStreamRetries }),
  });
}

async function collect(
  provider: PiProvider,
  messages: Message[] = [{ role: 'user', content: 'go' }],
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.chat(messages, { model: FLAKY_MODEL.id })) {
    chunks.push(chunk);
  }
  return chunks;
}

function toolTexts(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is Extract<StreamChunk, { type: 'tool_call_delta' }> => c.type === 'tool_call_delta')
    .map((c) => c.arguments)
    .join('');
}

describe('PiProvider stream-retry-boundary', () => {
  it('retries a stream that dies inside tool-call args, emitting one clean call', async () => {
    const { engine, attempts } = makeFlakyEngine((n) =>
      n === 1 ? [...stalledToolCallEvents(), errorEvent('error')] : fullToolCallEvents(),
    );
    const chunks = await collect(makeProvider(engine));

    expect(attempts()).toBe(2);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(chunks.filter((c) => c.type === 'tool_call_start')).toEqual([
      { type: 'tool_call_start', id: 'c1', name: 'read_file' },
    ]);
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(true);
    expect(JSON.parse(toolTexts(chunks))).toEqual({ path: 'e2e.txt' });
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
  });

  it('does NOT retry once a text delta committed the stream', async () => {
    const { engine, attempts } = makeFlakyEngine(() => [
      { type: 'start', partial: basePartial() },
      { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: basePartial() },
      errorEvent('error'),
    ]);
    const chunks = await collect(makeProvider(engine));
    expect(attempts()).toBe(1);
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(chunks.filter((c) => c.type === 'text_delta')).toHaveLength(1);
  });

  it('does NOT retry a user abort', async () => {
    const { engine, attempts } = makeFlakyEngine((n) =>
      n === 1 ? [...stalledToolCallEvents(), errorEvent('aborted')] : fullToolCallEvents(),
    );
    const chunks = await collect(makeProvider(engine));
    expect(attempts()).toBe(1);
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
  });

  it('does NOT retry a deterministic context-overflow error', async () => {
    const { engine, attempts } = makeFlakyEngine(() => [
      ...stalledToolCallEvents(),
      errorEvent('error', 'This model maximum context length is 4096 tokens'),
    ]);
    const chunks = await collect(makeProvider(engine));
    expect(attempts()).toBe(1); // retrying the same payload is pointless
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
  });

  it('streams thinking deltas live (watchdog keeps seeing bytes) and still retries', async () => {
    const { engine, attempts } = makeFlakyEngine((n) =>
      n === 1
        ? [
            { type: 'start', partial: basePartial() },
            { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: basePartial() },
            ...stalledToolCallEvents().slice(1),
            errorEvent('error'),
          ]
        : fullToolCallEvents(),
    );
    const seen: StreamChunk[] = [];
    const gen = makeProvider(engine).chat([{ role: 'user', content: 'go' }], {
      model: FLAKY_MODEL.id,
    });
    // Consume lazily: the thinking delta must be observable BEFORE the
    // attempt-1 error resolves, i.e. it was not swallowed into the buffer.
    for await (const chunk of gen) seen.push(chunk);
    expect(attempts()).toBe(2);
    expect(seen.filter((c) => c.type === 'thinking_delta')).toHaveLength(1);
    expect(seen.some((c) => c.type === 'error')).toBe(false);
    expect(seen.some((c) => c.type === 'tool_call_end')).toBe(true);
  });

  it('surfaces the error once the retry budget is exhausted', async () => {
    const { engine, attempts } = makeFlakyEngine((n) =>
      n === 1
        ? [...stalledToolCallEvents(), errorEvent('error', 'first boom')]
        : [...stalledToolCallEvents(), errorEvent('error', 'second boom')],
    );
    const chunks = await collect(makeProvider(engine));
    expect(attempts()).toBe(2); // 1 attempt + 1 retry
    const errors = chunks.filter((c) => c.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: string }).error).toContain('second boom');
  });

  it('maxStreamRetries: 0 disables retrying entirely', async () => {
    const { engine, attempts } = makeFlakyEngine(() => [
      ...stalledToolCallEvents(),
      errorEvent('error'),
    ]);
    const chunks = await collect(makeProvider(engine, 0));
    expect(attempts()).toBe(1);
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
  });

  it('thrown provider failures inside the prelude also retry', async () => {
    let count = 0;
    const engine = createPiaiEngine();
    engine.models.setProvider(
      createProvider({
        id: 'flaky',
        auth: { apiKey: envApiKeyAuth('Flaky', ['FLAKY_API_KEY']) },
        models: [FLAKY_MODEL],
        api: {
          stream: () => {
            throw new Error('connect ECONNRESET');
          },
          streamSimple: () => {
            count++;
            if (count === 1) throw new Error('connect ECONNRESET');
            return scriptedStream(fullToolCallEvents());
          },
        },
      }),
    );
    const chunks = await collect(makeProvider(engine));
    expect(count).toBe(2);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(true);
  });
});
