import { describe, it, expect, vi } from 'vitest';
import {
  microcompactMessages,
  MICROCOMPACT_MARKER,
  DEFAULT_MICROCOMPACT_TOOLS,
} from '../../src/agent/microcompact.js';
import { SUMMARY_MARKER } from '../../src/agent/compaction.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool } from '../../src/tools/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

/**
 * Ticket zcode-borrow 01 — microcompact: a zero-LLM layer that clears old
 * tool RESULTS (keeping the newest groups verbatim) before the existing
 * truncate/compact strategies get a chance to run.
 */

function bigBody(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}: some realistic file content here`).join('\n');
}

/** ~4 chars/token heuristic matching the production fallback estimator. */
const est = (text: string): number => Math.ceil(text.length / 4);

/** Test wrapper: microcompactMessages with the estimator always injected. */
function mc(messages: Message[], options: Omit<Parameters<typeof microcompactMessages>[1], 'countTokens'> = {}) {
  return microcompactMessages(messages, { countTokens: est, ...options });
}

/** One assistant(tool_calls)+tool(result) group for the named tool. */
function group(name: string, id: string, resultContent: string): Message[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: resultContent },
  ];
}

describe('microcompactMessages (pure layer)', () => {
  it('clears tool results older than the kept-group window', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      ...group('read_file', 'a', bigBody(60)),
      ...group('read_file', 'b', bigBody(60)),
      ...group('read_file', 'c', bigBody(60)),
    ];
    const result = mc(messages, { keepRecentGroups: 1 });
    expect(result.applied).toBe(true);
    expect(result.messages).toHaveLength(7);
    // oldest two cleared, newest kept
    expect((result.messages[2] as { content: string }).content.startsWith(MICROCOMPACT_MARKER)).toBe(true);
    expect((result.messages[4] as { content: string }).content.startsWith(MICROCOMPACT_MARKER)).toBe(true);
    expect((result.messages[6] as { content: string }).content.startsWith('line 0:')).toBe(true);
  });

  it('keeps the newest N groups verbatim (default 5)', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) messages.push(...group('read_file', `t${i}`, bigBody(60)));
    const result = mc(messages);
    const cleared = result.messages.filter(
      (m) => m.role === 'tool' && (m.content ?? '').startsWith(MICROCOMPACT_MARKER),
    );
    expect(cleared).toHaveLength(2); // 7 groups, keep 5
  });

  it('only clears whitelisted tools; non-compactable results stay verbatim', () => {
    expect(DEFAULT_MICROCOMPACT_TOOLS).toContain('read_file');
    const messages: Message[] = [
      ...group('read_file', 'a', bigBody(80)),
      ...group('todo', 'b', bigBody(80)),
      ...group('read_file', 'c', bigBody(80)),
      ...group('read_file', 'd', bigBody(80)),
      ...group('read_file', 'e', bigBody(80)),
      ...group('read_file', 'f', bigBody(80)),
    ];
    const result = mc(messages, { keepRecentGroups: 0 });
    const todo = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'b');
    const readA = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'a');
    expect((todo?.content ?? '').startsWith('line 0:')).toBe(true);
    expect((readA?.content ?? '').startsWith(MICROCOMPACT_MARKER)).toBe(true);
  });

  it('fail-closed: a tool result with no owning tool call is never cleared', () => {
    const orphan: Message = { role: 'tool', tool_call_id: 'ghost', content: bigBody(200) };
    const messages: Message[] = [
      orphan,
      ...group('read_file', 'x', bigBody(200)),
      ...group('read_file', 'y', bigBody(200)),
    ];
    const result = mc(messages, { keepRecentGroups: 0 });
    const keptOrphan = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'ghost');
    expect(keptOrphan?.content).toBe(bigBody(200));
  });

  it('never clears inline-media (data URL) results, even when whitelisted', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(20_000)}`;
    const messages: Message[] = [
      ...group('snapshot', 'm1', dataUrl),
      ...group('snapshot', 'm2', dataUrl),
    ];
    const result = mc(messages, { keepRecentGroups: 0, compactableTools: ['snapshot'] });
    expect(result.applied).toBe(false);
  });

  it('is idempotent and recognizes both marker spellings', () => {
    const messages: Message[] = [
      ...group('read_file', 'a', bigBody(200)),
      ...group('read_file', 'b', bigBody(200)),
    ];
    const first = mc(messages, { keepRecentGroups: 0 });
    expect(first.applied).toBe(true);
    const second = mc(first.messages, { keepRecentGroups: 0 });
    expect(second.applied).toBe(false);
    expect(second.messages).toBe(first.messages); // nothing to do, same array
    // compaction.ts-style placeholder is also left alone
    const legacy: Message[] = [
      { role: 'tool', tool_call_id: 'z', content: '[Old tool result cleared — 9000 chars]' },
    ];
    const r = mc(legacy, { keepRecentGroups: 0 });
    expect(r.applied).toBe(false);
  });

  it('skips clearing below the minimum-savings gate', () => {
    const messages: Message[] = [
      ...group('read_file', 'a', 'tiny'),
      ...group('read_file', 'b', 'tiny'),
    ];
    const result = mc(messages, { keepRecentGroups: 0, minSavingsTokens: 256 });
    expect(result.applied).toBe(false);
    expect(result.savedTokens).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('reports clearedResults and savedTokens above the gate', () => {
    const messages: Message[] = [
      ...group('read_file', 'a', bigBody(300)),
      ...group('read_file', 'b', bigBody(300)),
    ];
    const result = mc(messages, { keepRecentGroups: 0 });
    expect(result.applied).toBe(true);
    expect(result.clearedResults).toBe(2);
    expect(result.savedTokens).toBeGreaterThanOrEqual(256);
  });

  it('never touches non-tool messages and preserves order/length', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      ...group('read_file', 'a', bigBody(120)),
      ...group('read_file', 'b', bigBody(120)),
      { role: 'assistant', content: 'done' },
    ];
    const result = mc(messages, { keepRecentGroups: 0 });
    expect(result.messages).toHaveLength(messages.length);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages[4]).toEqual(messages[4]); // assistant message untouched
  });
});

// --- loop integration -------------------------------------------------------

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function mockLLM(responses: StreamChunk[][]): LLMProvider {
  let i = 0;
  return {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(_msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
      for (const chunk of responses[i++] ?? []) {
        yield chunk;
      }
    },
  };
}

function readTool(): Tool {
  return {
    name: 'read_file',
    description: 'Read',
    permission: { mode: 'auto' as const },
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: 'x' }),
  };
}

function seedGroups(count: number, lines: number): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < count; i++) out.push(...group('read_file', `s${i}`, bigBody(lines)));
  return out;
}

/** One huge old group + N small recent ones: micro-clearing the huge group
 * alone brings the context back under the trigger on both token estimators. */
function seedOneHugePlus(hugeLines: number, smallCount: number): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start' }];
  out.push(...group('read_file', 's0', bigBody(hugeLines)));
  for (let i = 1; i <= smallCount; i++) out.push(...group('read_file', `s${i}`, bigBody(20)));
  return out;
}

function makeLoop(contextConfig: import('../../src/agent/loop.js').LoopContextConfig): {
  loop: AgentLoop;
  compactions: Array<{ strategy: string; before: number; after: number }>;
} {
  const llm = mockLLM([[{ type: 'text_delta', content: 'ok' }]]);
  const registry = new ToolRegistry();
  registry.register(readTool());
  const compactions: Array<{ strategy: string; before: number; after: number }> = [];
  const loop = new AgentLoop({
    llm,
    toolRegistry: registry,
    toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
    config: { maxToolRounds: 5, model: 'test' },
    context: contextConfig,
    onCompaction: (info) => compactions.push({ strategy: info.strategy, before: info.beforeTokens, after: info.afterTokens }),
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPermissionRequest: async () => true,
  });
  return { loop, compactions };
}

describe('AgentLoop microcompact integration', () => {
  it('pressure: clears old tool results via the truncate strategy without dropping messages', async () => {
    // Window 4000/reserve 1000 → trigger 3000. One huge oldest group busts
    // the trigger; clearing exactly that group (keep 5 of 6) fits again.
    const { loop, compactions } = makeLoop({ maxTokens: 4000, reserveTokens: 1000, strategy: 'truncate' });
    const seeded = seedOneHugePlus(220, 5);
    loop.loadMessages(seeded);
    await loop.processUserInput('continue');

    const messages = loop.getMessages();
    expect(messages).toHaveLength(seeded.length + 2); // turn's user + assistant added, nothing dropped
    const cleared = messages.filter((m) => m.role === 'tool' && (m.content ?? '').startsWith(MICROCOMPACT_MARKER));
    expect(cleared).toHaveLength(1);
    const micro = compactions.find((c) => c.strategy === 'microcompact');
    expect(micro).toBeDefined();
    // demo evidence: the pass moved a long session measurably down
    expect(micro!.before - micro!.after).toBeGreaterThanOrEqual(256);
  });

  it('idle: runs microcompact past the idle threshold even below the token trigger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    try {
      const { loop } = makeLoop({
        maxTokens: 100_000,
        reserveTokens: 1000,
        strategy: 'truncate',
        microcompactIdleMs: 60 * 60 * 1000,
      });
      loop.loadMessages(seedGroups(7, 60)); // well below any trigger
      vi.setSystemTime(new Date('2026-09-20T13:01:00Z')); // 61 min idle
      await loop.processUserInput('continue');
      const cleared = loop.getMessages().filter(
        (m) => m.role === 'tool' && (m.content ?? '').startsWith(MICROCOMPACT_MARKER),
      );
      expect(cleared.length).toBeGreaterThanOrEqual(1); // keep-5 of 7 → 2 cleared
    } finally {
      vi.useRealTimers();
    }
  });

  it('coexistence: when micro cannot meet the gate, the compact strategy still summarizes', async () => {
    const llm = mockLLM([
      [{ type: 'text_delta', content: 'SUMMARY BODY' }], // compaction summarization call
      [{ type: 'text_delta', content: 'ok' }],            // main turn
    ]);
    const registry = new ToolRegistry();
    registry.register(readTool());
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 5, model: 'test' },
      context: { maxTokens: 4000, reserveTokens: 1000, keepRecentTokens: 500, strategy: 'compact' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    // Fat ASSISTANT text (not tool results): micro has nothing to clear,
    // the LLM summary path must still run unchanged.
    loop.loadMessages([
      { role: 'user', content: 'start' },
      { role: 'assistant', content: bigBody(400) },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: bigBody(400) },
    ]);
    await loop.processUserInput('continue');
    const first = loop.getMessages()[0];
    expect(first.role).toBe('system');
    expect(first.content?.startsWith(SUMMARY_MARKER)).toBe(true);
  });
});
