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

  it('persists a compaction snapshot and replay replaces prior history', async () => {
    const file = path.join(dir, 'session-2.jsonl');
    const store = new SessionStore(file);
    await store.append({ role: 'user', content: 'long question' });
    await store.append({ role: 'assistant', content: 'long answer' });
    // Compaction collapses everything into a summarized state
    await store.appendCompaction([
      { role: 'system', content: '[Conversation summary]\nuser asked something' },
      { role: 'user', content: 'next question' },
    ]);
    await store.close();

    const loaded = SessionStore.load(file);
    // Pre-compaction messages replaced by the snapshot
    expect(loaded).toHaveLength(2);
    expect(loaded[0].role).toBe('system');
    expect(loaded[0].content).toContain('[Conversation summary]');
    expect(loaded[1]).toEqual({ role: 'user', content: 'next question' });
  });

  it('replays multiple compaction entries progressively', async () => {
    const file = path.join(dir, 'session-3.jsonl');
    const store = new SessionStore(file);
    await store.append({ role: 'user', content: 'a' });
    await store.appendCompaction([{ role: 'system', content: 'summary one' }]);
    await store.append({ role: 'user', content: 'b' });
    await store.appendCompaction([{ role: 'system', content: 'summary two' }]);
    await store.close();

    const loaded = SessionStore.load(file);
    expect(loaded).toEqual([{ role: 'system', content: 'summary two' }]);
  });

  it('loads legacy session files (messages only) unchanged', () => {
    const file = path.join(dir, 'legacy.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"old format"}\n');
    expect(SessionStore.load(file)).toEqual([{ role: 'user', content: 'old format' }]);
  });

  it('skips malformed compaction entries', () => {
    const file = path.join(dir, 'corrupt2.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: 'user', content: 'ok' }),
        JSON.stringify({ type: 'compaction' }), // missing messages
        JSON.stringify({ type: 'compaction', messages: 'not-an-array' }),
      ].join('\n'),
    );
    expect(SessionStore.load(file)).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('listSummaries lists sessions newest-first with count and preview', () => {
    const old = path.join(dir, 'session-old.jsonl');
    const newer = path.join(dir, 'session-new.jsonl');
    fs.writeFileSync(old, [
      JSON.stringify({ role: 'user', content: 'first user question in old session' }),
      JSON.stringify({ role: 'assistant', content: 'answer' }),
    ].join('\n'));
    fs.writeFileSync(newer, [
      JSON.stringify({ role: 'system', content: 'skill body' }),
      JSON.stringify({ role: 'user', content: 'fix the login bug please' }),
    ].join('\n'));
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(old, past, past);

    const list = SessionStore.listSummaries(dir);
    expect(list).toHaveLength(2);
    expect(list[0].file).toBe(newer); // newest first
    expect(list[0].messageCount).toBe(2);
    // Preview = first USER message (not system noise), truncated to 60
    expect(list[0].preview).toBe('fix the login bug please');
    expect(list[1].messageCount).toBe(2);
    expect(list[1].preview.length).toBeLessThanOrEqual(60);
  });

  it('listSummaries returns [] for empty or missing directories', () => {
    expect(SessionStore.listSummaries(dir)).toEqual([]);
    expect(SessionStore.listSummaries(path.join(dir, 'nope'))).toEqual([]);
  });

  it('listSummaries ignores non-session files', () => {
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a session');
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), '{"role":"user","content":"hi"}\n');
    const list = SessionStore.listSummaries(dir);
    expect(list).toHaveLength(1);
    expect(list[0].file).toContain('session-a.jsonl');
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
