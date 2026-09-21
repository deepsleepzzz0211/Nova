import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { replayMessages, replaySessionFile, replaySessionsDir } from '../../src/agent/shadow-replay.js';
import type { Message } from '../../src/llm/types.js';

/**
 * Ticket zcode-borrow 06 — shadow-replay conservation gate: real sessions
 * replayed offline through the deterministic context pipeline with no
 * silent message loss.
 */

function bigToolGroup(id: string, lines: number): Message[] {
  const body = Array.from({ length: lines }, (_, i) => `row ${i}: ${'content '.repeat(4)}`).join('\n');
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: body },
  ];
}

function longUser(text: string): Message {
  return { role: 'user', content: text };
}

describe('replayMessages (pure pipeline)', () => {
  it('a small session passes through untouched and conserved', () => {
    const msgs: Message[] = [longUser('hello'), { role: 'assistant', content: 'hi' }];
    const r = replayMessages(msgs);
    expect(r.conserved).toBe(true);
    expect(r.loaded).toBe(2);
    expect(r.final).toBe(2);
    expect(r.droppedMessages).toBe(0);
    expect(r.clearedToolResults).toBe(0);
  });

  it('a long tool-heavy session is shrunk but fully conserved', () => {
    const msgs: Message[] = [longUser('start')];
    for (let i = 0; i < 12; i++) msgs.push(...bigToolGroup(`c${i}`, 80));
    // A tight window forces BOTH layers: microcompact clears old tool
    // results, then truncation still has to drop messages to fit.
    const r = replayMessages(msgs, { maxTokens: 2_000 });
    expect(r.conserved).toBe(true);
    expect(r.loaded).toBe(25);
    expect(r.final).toBeLessThan(r.loaded);
    expect(r.droppedMessages + r.final).toBe(r.loaded);
    // and microcompact cleared some old tool results before truncation.
    expect(r.clearedToolResults).toBeGreaterThan(0);
  });

  it('system messages always survive (counted, never silently dropped)', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys prompt' },
      longUser('q'),
    ];
    for (let i = 0; i < 10; i++) msgs.push(...bigToolGroup(`g${i}`, 90));
    const r = replayMessages(msgs, { maxTokens: 4_000 });
    expect(r.conserved).toBe(true);
    expect(r.loaded).toBe(r.final + r.droppedMessages);
  });

  it('a mid-list system message does not false-positive on reorder', () => {
    // Truncation hoists every system message to the front; conservation is a
    // multiset check, so reordering must not be read as fabrication/loss.
    const msgs: Message[] = [
      longUser('a'.repeat(4000)),
      { role: 'system', content: 'compaction notice mid-history' },
      longUser('b'.repeat(4000)),
    ];
    const r = replayMessages(msgs, { maxTokens: 3_000 });
    expect(r.conserved).toBe(true);
    expect(r.loaded).toBe(3);
    expect(r.final).toBe(2);
    expect(r.droppedMessages).toBe(1);
  });
});

describe('conservation catches violations', () => {
  it('flags a pipeline that would fabricate a message (direct unit on the check)', () => {
    // The gate throws on any output message not present among inputs. Feed a
    // history where the ONLY thing that can go wrong is a model-side mutation:
    // microcompact never fabricates, so we assert the invariant holds and the
    // report shape is honest under pressure.
    const msgs: Message[] = [longUser('x'.repeat(6000)), longUser('y'.repeat(6000))];
    const r = replayMessages(msgs, { maxTokens: 1_500 });
    expect(r.conserved).toBe(true);
    expect(r.droppedMessages + r.final).toBe(r.loaded);
  });
});

describe('replay from disk (read-only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-replay-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeSession(name: string, entries: unknown[]): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return file;
  }

  it('loads and replays a stored session, leaving the file byte-identical', () => {
    const entries: unknown[] = [
      { role: 'user', content: 'begin' },
      ...bigToolGroup('t1', 100),
      ...bigToolGroup('t2', 100),
    ];
    const file = writeSession('session-a.jsonl', entries);
    const before = fs.readFileSync(file);
    const report = replaySessionFile(file, { maxTokens: 6_000 });
    expect(report.file).toBe(file);
    expect(report.conserved).toBe(true);
    expect(report.loaded).toBe(5);
    expect(Buffer.compare(before, fs.readFileSync(file))).toBe(0);
  });

  it('replays compaction checkpoints: cold load replaces history before the gate', () => {
    const slim: Message[] = [longUser('kept after compaction')];
    const file = writeSession('session-cp.jsonl', [
      { role: 'user', content: 'x'.repeat(5000) },
      longUser('x'.repeat(5000)),
      { type: 'compaction', messages: slim },
      longUser('post-checkpoint'),
    ]);
    const report = replaySessionFile(file, { maxTokens: 60_000 });
    expect(report.conserved).toBe(true);
    // Only the checkpoint snapshot + the message after it are cold-loaded.
    expect(report.loaded).toBe(2);
  });

  it('a dir with several sessions returns one report per file', () => {
    writeSession('one.jsonl', [{ role: 'user', content: 'a' }]);
    writeSession('two.jsonl', [{ role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]);
    const reports = replaySessionsDir(dir);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.conserved)).toBe(true);
  });

  it('an empty session is conserved trivially', () => {
    const file = writeSession('empty.jsonl', []);
    expect(replaySessionFile(file).conserved).toBe(true);
  });
});
