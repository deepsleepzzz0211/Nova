import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../../src/agent/session.js';
import type { Message } from '../../src/llm/types.js';

describe('SessionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sessions-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends messages as JSONL and loads them back in order', async () => {
    const file = path.join(dir, 'session-1.jsonl');
    const store = new SessionStore(file);
    await store.append({ role: 'user', content: 'hello' });
    await store.append({ role: 'assistant', content: 'hi' });
    await store.append({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] });
    await store.append({ role: 'tool', tool_call_id: 'c1', content: 'file.txt', is_error: false });
    await store.close();

    const loaded = SessionStore.load(file);
    expect(loaded).toHaveLength(4);
    expect(loaded[0]).toEqual({ role: 'user', content: 'hello' });
    expect(loaded[2].tool_calls).toHaveLength(1);
    expect(loaded[3].role).toBe('tool');
  });

  it('findLatestSession returns the most recently modified file', () => {
    const older = path.join(dir, 'session-old.jsonl');
    const newer = path.join(dir, 'session-new.jsonl');
    fs.writeFileSync(older, '{"role":"user","content":"old"}\n');
    fs.writeFileSync(newer, '{"role":"user","content":"new"}\n');
    // Make `older` clearly older than `newer`
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(older, past, past);

    expect(SessionStore.findLatest(dir)).toBe(newer);
  });

  it('findLatestSession returns null when directory is empty or missing', () => {
    expect(SessionStore.findLatest(dir)).toBeNull();
    expect(SessionStore.findLatest(path.join(dir, 'nope'))).toBeNull();
  });

  it('load skips malformed lines', () => {
    const file = path.join(dir, 'corrupt.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: 'user', content: 'ok' }),
        'not json',
        JSON.stringify({ role: 'assistant', content: 'also ok' }),
      ].join('\n'),
    );
    const loaded = SessionStore.load(file);
    expect(loaded).toHaveLength(2);
  });

  it('append queues writes preserving order without awaiting each call', async () => {
    const file = path.join(dir, 'queued.jsonl');
    const store = new SessionStore(file);
    // Fire all appends without await
    const p1 = store.append({ role: 'user', content: 'one' });
    const p2 = store.append({ role: 'user', content: 'two' });
    const p3 = store.append({ role: 'user', content: 'three' });
    await Promise.all([p1, p2, p3]);
    await store.close();

    const loaded: Message[] = SessionStore.load(file);
    expect(loaded.map((m) => (m as { content: string }).content)).toEqual(['one', 'two', 'three']);
  });
});
