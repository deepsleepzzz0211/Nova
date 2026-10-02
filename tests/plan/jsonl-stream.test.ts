import { describe, it, expect } from 'vitest';
import { createJsonlSink, MAX_EVENT_BYTES } from '../../src/cli/jsonl-stream.js';

// Batch-B ticket 08: `nova -p --output-format jsonl` emits NDJSON events on
// stdout — one JSON object per line, schema version v:1, any single event
// over 64KB content-truncated with truncated:true (the [PARTIAL] discipline).

function collect(): { lines: string[]; emit: ReturnType<typeof createJsonlSink> } {
  const lines: string[] = [];
  return { lines, emit: createJsonlSink((l) => lines.push(l)) };
}

const parse = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

describe('jsonl sink events', () => {
  it('start carries the schema version, session id and model', () => {
    const c = collect();
    c.emit.start('sess-9', 'weixin/Deepseek-v4-flash');
    expect(c.lines).toHaveLength(1);
    expect(parse(c.lines[0]!)).toEqual({
      v: 1,
      ev: 'start',
      session_id: 'sess-9',
      model: 'weixin/Deepseek-v4-flash',
    });
    expect(c.lines[0]!.endsWith('\n')).toBe(false); // writer owns newlines
  });

  it('text emits one delta per line', () => {
    const c = collect();
    c.emit.text('hello ');
    c.emit.text('world');
    expect(parse(c.lines[0]!)).toEqual({ v: 1, ev: 'text', delta: 'hello ' });
    expect(parse(c.lines[1]!)).toEqual({ v: 1, ev: 'text', delta: 'world' });
  });

  it('tool_call fires with complete arguments', () => {
    const c = collect();
    c.emit.toolCall({ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' });
    expect(parse(c.lines[0]!)).toEqual({
      v: 1,
      ev: 'tool_call',
      id: 'call-1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
    });
  });

  it('tool_result carries the error flag and stays out of stderr', () => {
    const c = collect();
    c.emit.toolResult({ id: 'call-1', name: 'bash', content: 'ok', isError: false });
    c.emit.toolResult({ id: 'call-2', name: 'bash', content: 'boom', isError: true });
    expect(parse(c.lines[1]!)).toEqual({
      v: 1,
      ev: 'tool_result',
      id: 'call-2',
      name: 'bash',
      content: 'boom',
      is_error: true,
    });
  });

  it('compaction, usage, result and error serialize the ticket fields', () => {
    const c = collect();
    c.emit.compaction({ strategy: 'compact', reason: 'threshold', beforeTokens: 900, afterTokens: 300 });
    c.emit.usage({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, cacheWriteTokens: 10 });
    c.emit.result({ text: 'final answer', rounds: 3, exitCode: 0 });
    c.emit.error('provider exploded');
    expect(parse(c.lines[0]!)).toEqual({
      v: 1, ev: 'compaction', strategy: 'compact', reason: 'threshold',
      before_tokens: 900, after_tokens: 300,
    });
    expect(parse(c.lines[1]!)).toEqual({
      v: 1, ev: 'usage', input_tokens: 100, output_tokens: 40,
      cached_tokens: 60, cache_write_tokens: 10,
    });
    expect(parse(c.lines[2]!)).toEqual({
      v: 1, ev: 'result', text: 'final answer', rounds: 3, exit_code: 0,
    });
    expect(parse(c.lines[3]!)).toEqual({ v: 1, ev: 'error', message: 'provider exploded' });
  });

  it('oversized content is truncated with truncated:true and stays under the byte cap', () => {
    const c = collect();
    c.emit.toolResult({ id: 'x', name: 'grep', content: 'A'.repeat(MAX_EVENT_BYTES * 2), isError: false });
    const evt = parse(c.lines[0]!);
    expect(evt.truncated).toBe(true);
    expect(String(evt.content).length).toBeLessThan(MAX_EVENT_BYTES);
    expect(Buffer.byteLength(c.lines[0]!, 'utf8')).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  it('oversized tool_call arguments truncate too (line cap is absolute)', () => {
    const c = collect();
    c.emit.toolCall({ id: 'y', name: 'write_file', arguments: 'B'.repeat(MAX_EVENT_BYTES * 2) });
    const evt = parse(c.lines[0]!);
    expect(evt.truncated).toBe(true);
    expect(Buffer.byteLength(c.lines[0]!, 'utf8')).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  it('result text over the cap truncates as well', () => {
    const c = collect();
    c.emit.result({ text: 'C'.repeat(MAX_EVENT_BYTES * 2), rounds: 9, exitCode: 1 });
    const evt = parse(c.lines[0]!);
    expect(evt.truncated).toBe(true);
    expect(evt.exit_code).toBe(1);
  });
});
