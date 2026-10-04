import { describe, it, expect } from 'vitest';
import {
  createTurnRouter,
  createTextSink,
  formatContextNote,
  formatCompactionLine,
  type TurnSink,
} from '../../src/cli/turn-router.js';
import type { ToolCall } from '../../src/llm/types.js';

// arch2 ticket A3: print mode, jsonl, and (later) the TUI were each
// re-implementing the same turn plumbing - id->name tool pairing, the
// [Error: token that decides the exit code, and the [context] formatting.
// createTurnRouter owns the plumbing behind a TurnSink interface; adapters
// only render.

function recordingSink(): TurnSink & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    text: (t) => events.push(`text:${t}`),
    toolCall: (c) => events.push(`call:${c.id}:${c.name}:${c.arguments}`),
    toolResult: (r) => events.push(`result:${r.id ?? '-'}:${r.name}:${r.isError}`),
    compaction: (i) => events.push(`compaction:${i.strategy}:${i.beforeTokens}->${i.afterTokens}`),
    contextNote: (n) => events.push(`note:${n}`),
    usage: (u) => events.push(`usage:${u.inputTokens}/${u.outputTokens}`),
    result: (r) => events.push(`done:${r.exitCode}:${r.rounds}`),
    error: (m) => events.push(`error:${m}`),
  };
}

const call = (id: string, name: string, args = '{}'): ToolCall =>
  ({ id, type: 'function', function: { name, arguments: args } }) as ToolCall;

describe('createTurnRouter', () => {
  it('streams tokens to the sink and remembers the [Error: prefix for the exit policy', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    router.callbacks.onToken('hello ');
    router.callbacks.onToken('[Error: provider exploded]');
    const { exitCode } = router.finish({ text: 'hello [Error: provider exploded]', rounds: 1 });
    expect(sink.events).toEqual([
      'text:hello ',
      'text:[Error: provider exploded]',
      'done:1:1',
    ]);
    expect(exitCode).toBe(1);
  });

  it('a clean turn finishes with exit code 0', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    router.callbacks.onToken('all good');
    expect(router.finish({ text: 'all good', rounds: 2 }).exitCode).toBe(0);
    expect(sink.events[sink.events.length - 1]).toBe('done:0:2');
  });

  it('pairs tool results with the call id -> name recorded at call-ready', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    router.callbacks.onToolCallReady?.(call('tc-1', 'bash', '{"command":"ls"}'));
    router.callbacks.onToolResult({ content: 'file list', isError: undefined }, 'tc-1');
    expect(sink.events).toContain('call:tc-1:bash:{"command":"ls"}');
    expect(sink.events).toContain('result:tc-1:bash:false');
  });

  it('an unpaired tool result still renders with the fallback name', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    router.callbacks.onToolResult({ content: 'x', isError: true }, 'never-seen');
    expect(sink.events).toContain('result:never-seen:tool:true');
  });

  it('routes compaction, context notes, and usage to the sink untouched', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    router.callbacks.onCompaction?.({
      strategy: 'compact',
      reason: 'pressure',
      beforeTokens: 100,
      afterTokens: 40,
    });
    router.callbacks.onContextNote?.('breaker opened');
    router.callbacks.onUsage?.({ inputTokens: 7, outputTokens: 3 });
    expect(sink.events).toEqual([
      'compaction:compact:100->40',
      'note:breaker opened',
      'usage:7/3',
    ]);
  });

  it('fail() reports the thrown-turn message through the sink and exits 1', () => {
    const sink = recordingSink();
    const router = createTurnRouter(sink);
    expect(router.fail('network down')).toEqual({ exitCode: 1 });
    expect(sink.events).toEqual(['error:network down']);
  });
});

describe('createTextSink (the human adapter)', () => {
  it('streams to stdout; compaction/notes/errors go to stderr with ONE format', () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = createTextSink({ out: (s) => out.push(s), err: (s) => err.push(s) });
    sink.text('answer');
    sink.compaction({ strategy: 'truncate', reason: 'overflow', beforeTokens: 10, afterTokens: 5 });
    sink.contextNote('hello note');
    sink.error('boom');
    sink.result({ text: 'answer', rounds: 1, exitCode: 0 });
    expect(out).toEqual(['answer', '\n']); // trailing newline added when missing
    expect(err).toEqual([
      '[context] truncate (overflow): 10 -> 5 tokens\n',
      '[context] hello note\n',
      '[error] boom\n',
    ]);
  });

  it('does not add a newline when the answer already ends with one', () => {
    const out: string[] = [];
    const sink = createTextSink({ out: (s) => out.push(s), err: () => {} });
    sink.result({ text: 'done\n', rounds: 1, exitCode: 0 });
    expect(out).toEqual([]);
  });
});

describe('context formatting owners (arch2 A3)', () => {
  it('the note line is exactly "[context] <note>" + newline', () => {
    expect(formatContextNote('a note')).toBe('[context] a note\n');
  });

  it('the compaction line keeps the historical shape', () => {
    expect(
      formatCompactionLine({ strategy: 'microcompact', reason: 'idle', beforeTokens: 3, afterTokens: 2 }),
    ).toBe('[context] microcompact (idle): 3 -> 2 tokens\n');
  });
});
