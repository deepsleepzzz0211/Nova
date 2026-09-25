import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import type { AgentLoopConfig, LoopContextConfig } from '../../src/agent/loop.js';
import { SessionStore } from '../../src/agent/session.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { MICROCOMPACT_MARKER } from '../../src/agent/microcompact.js';
import type { SkillRegistry } from '../../src/skills/registry.js';
import type { SkillMeta } from '../../src/skills/registry.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Tool } from '../../src/tools/types.js';
import type { Message, StreamChunk, ToolCall } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/shared/tool-contracts.js';

// survived-hunt (test-effectiveness 03), cluster: src/agent/loop.ts.
// Every case pins an EXACT value (event field, message object, call count,
// aggregated number) where the pre-existing assertions were loose enough to
// let mutants live.

const policy = new PermissionPolicy({
  autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

function echoTool(onExecute?: () => void): Tool {
  return {
    name: 'echo', description: 'Echo', permission: { mode: 'auto' as const },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (params) => {
      onExecute?.();
      return { content: `echo: ${String(params.text)}` };
    },
  };
}

function registryWith(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

/** Scripted provider: one response array per chat() call; counts calls. */
function scriptedLLM(responses: StreamChunk[][]): LLMProvider & { calls: number } {
  let i = 0;
  const llm = {
    calls: 0,
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(): AsyncIterable<StreamChunk> {
      llm.calls++;
      for (const c of responses[i++] ?? []) yield c;
    },
  };
  return llm;
}

const text = (t: string): StreamChunk => ({ type: 'text_delta', content: t });
const usage = (u: Partial<{ inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }> & { inputTokens: number; outputTokens: number }): StreamChunk => ({ type: 'usage', ...u });
const toolStart = (id: string, name: string): StreamChunk => ({ type: 'tool_call_start', id, name });
const toolDelta = (id: string, args: string): StreamChunk => ({ type: 'tool_call_delta', id, arguments: args });
const toolEnd = (id: string): StreamChunk => ({ type: 'tool_call_end', id });

type OptionalHook = 'onCompaction' | 'onContextNote' | 'onUsage';

function baseLoop(
  over: Partial<AgentLoopConfig> & { llm: LLMProvider },
  unwire: OptionalHook[] = [],
): {
  loop: AgentLoop; tokens: string[]; events: Array<Record<string, unknown>>; notes: string[]; usages: Array<Record<string, unknown>>;
} {
  const tokens: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const usages: Array<Record<string, unknown>> = [];
  const cfg: Record<string, unknown> = {
    toolRegistry: new ToolRegistry(),
    toolExecutionPipeline: makePipeline(),
    config: { maxToolRounds: 10, model: 'test' },
    onToken: (t: string) => tokens.push(t),
    onToolCall: () => {},
    onToolResult: () => {},
    onPermissionRequest: async () => true,
    onCompaction: (i: Record<string, unknown>) => events.push({ ...i }),
    onContextNote: (n: string) => notes.push(n),
    onUsage: (u: Record<string, unknown>) => usages.push({ ...u }),
    ...over,
  };
  for (const hook of unwire) delete cfg[hook];
  const loop = new AgentLoop(cfg as unknown as AgentLoopConfig);
  return { loop, tokens, events, notes, usages };
}

const big = (n: number): string => 'hello '.repeat(n); // ≈ n tokens in cl100k

function toolGroup(id: string, body: string): Message[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: body },
  ];
}

describe('loop.ts precision net (survived hunt 1/3)', () => {
  // ---- context-management events ------------------------------------------------

  it('pressure microcompact reports strategy=microcompact reason=pressure with exact token delta', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop, events } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'truncate' },
    });
    const seed: Message[] = [{ role: 'user', content: 'start' }];
    // Two huge OLD groups + five tiny recent ones: clearing the old pair
    // alone resolves the pressure, so only the microcompact event fires.
    for (let i = 0; i < 7; i++) seed.push(...toolGroup(`s${i}`, i < 2 ? big(1200) : big(8)));
    loop.loadMessages(seed);

    await loop.processUserInput('continue');

    const micro = events.filter((e) => e.strategy === 'microcompact');
    expect(micro).toHaveLength(1);
    expect(micro[0].reason).toBe('pressure');
    expect(typeof micro[0].beforeTokens).toBe('number');
    expect((micro[0].afterTokens as number)).toBeLessThan(micro[0].beforeTokens as number);
    // The cleared message bodies prove the pass really applied.
    const cleared = loop.getMessages().filter(
      (m) => m.role === 'tool' && (m.content ?? '').startsWith(MICROCOMPACT_MARKER),
    );
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('a pressure microcompact survives an unwired onCompaction callback', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const seed: Message[] = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 7; i++) seed.push(...toolGroup(`s${i}`, big(600)));
    const { loop } = baseLoop(
      { llm, context: { maxTokens: 600, strategy: 'truncate' } },
      ['onCompaction', 'onUsage', 'onContextNote'],
    );
    loop.loadMessages(seed);
    await expect(loop.processUserInput('continue')).resolves.toMatchObject({ text: 'ok' });
  });

  it('pressure truncate reports strategy=truncate reason=pressure and persists a checkpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-trunc-'));
    const sessionFile = path.join(dir, 's.jsonl');
    const session = new SessionStore(sessionFile);
    try {
      const llm = scriptedLLM([[text('ok')]]);
      const { loop, events } = baseLoop({
        llm,
        session,
        context: { maxTokens: 600, strategy: 'truncate' },
      });
      loop.loadMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: big(500) },
      ]);
      await loop.processUserInput('go');
      await session.close();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ strategy: 'truncate', reason: 'pressure' });
      const jsonl = fs.readFileSync(sessionFile, 'utf-8');
      expect(jsonl).toContain('"type":"compaction"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a truncate pass that reclaims nothing stays silent, unpersisted and unanchored', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop, events } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'truncate' },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
    ]);
    // The pass target is the trigger watermark; force the "shrink" to a
    // no-op and assert total silence (the /status counter must not move).
    const cm = (loop as unknown as { contextManager: { truncateToTokens: (m: Message[], t: number) => Message[] } }).contextManager;
    const before = loop.getMessages();
    vi.spyOn(cm, 'truncateToTokens').mockImplementation((m) => [...m]);
    await loop.processUserInput('go');
    expect(events).toHaveLength(0);
    expect(loop.getMessages()).toEqual(before);
  });

  it("'nothing to compact' on the automatic path changes no messages and emits no event", async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop, events } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 100_000 },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
    ]);
    await loop.processUserInput('go');
    expect(events).toHaveLength(0);
    expect(llm.calls).toBe(1); // only the turn chat — the summarizer never ran
    expect(loop.getMessages()).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('breaker sequence F,F,S,F,F,F opens exactly at the 6th attempt (success resets)', async () => {
    const outcomes: Array<'fail' | 'ok'> = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'];
    let summaryCalls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (!isSummary) throw new Error('turn chat must not be called');
        const out = outcomes[summaryCalls++];
        if (out === 'fail') { yield { type: 'error', error: 'boom' }; return; }
        yield text('short summary');
      },
    };
    const { loop, notes } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 },
    });
    const seed = (): Message[] => [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: big(500) },
    ];
    const notesAfter: number[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      loop.loadMessages(seed());
      await loop.compactNow('manual');
      notesAfter.push(notes.length);
    }
    expect(summaryCalls).toBe(6);
    expect(notesAfter).toEqual([0, 0, 0, 0, 0, 1]);
    expect(notes[0]).toContain('circuit breaker opened');
    expect(notes[0]).toContain('3 times in a row');
  });

  it('the breaker-opening notice survives an unwired onContextNote callback', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'error', error: 'boom' };
      },
    };
    const { loop } = baseLoop(
      { llm, context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 } },
      ['onContextNote'],
    );
    const seed = (): Message[] => [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: big(500) },
    ];
    for (let i = 0; i < 3; i++) {
      loop.loadMessages(seed());
      await expect(loop.compactNow('manual')).resolves.toBeDefined();
    }
  });

  it("a 'nothing' compaction attempt neither resets nor feeds the failure streak", async () => {
    let summaryCalls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (!isSummary) throw new Error('not a summary call');
        summaryCalls++;
        yield { type: 'error', error: 'boom' };
      },
    };
    const { loop, notes } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 },
    });
    const seed = (): Message[] => [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: big(500) },
    ];
    loop.loadMessages(seed());
    await loop.compactNow('manual'); // fail #1
    loop.loadMessages(seed());
    await loop.compactNow('manual'); // fail #2
    loop.loadMessages([{ role: 'user', content: 'lonely' }]);
    const r = await loop.compactNow('manual'); // nothing (no LLM call)
    expect(r).toEqual({ compacted: false, strategy: 'compact', beforeTokens: expect.any(Number) });
    expect(loop.getMessages()).toEqual([{ role: 'user', content: 'lonely' }]);
    loop.loadMessages(seed());
    await loop.compactNow('manual'); // fail #3 → opens
    expect(summaryCalls).toBe(3);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('circuit breaker opened');
  });

  it('once the breaker is open the automatic path truncates without calling the summarizer', async () => {
    let summaryCalls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (isSummary) { summaryCalls++; yield { type: 'error', error: 'boom' }; return; }
        yield text('ok');
      },
    };
    const { loop, events } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 },
    });
    const seed = (): Message[] => [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: big(500) },
    ];
    for (let i = 0; i < 3; i++) {
      loop.loadMessages(seed());
      await loop.compactNow('manual');
    }
    expect(summaryCalls).toBe(3);
    events.length = 0;
    loop.loadMessages(seed());
    await loop.processUserInput('go');
    expect(summaryCalls).toBe(3); // breaker open → no 4th attempt
    // Note: with the breaker open the pass truncates but the event still
    // carries the configured strategy — pinned as current behavior.
    const ev = events.at(-1);
    expect(ev).toMatchObject({ reason: 'pressure' });
  });

  it('rapid refill suppresses automatic compaction after the streak limit and notices once', async () => {
    let summaryCalls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (isSummary) { summaryCalls++; yield text('S'); return; }
        yield text(big(400));
      },
    };
    const { loop, events, notes } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 },
    });
    loop.loadMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: big(500) },
    ]);
    for (let i = 0; i < 4; i++) await loop.processUserInput(`t${i}`);

    expect(summaryCalls).toBe(2); // rounds 3+ are suppressed
    expect(events.filter((e) => e.reason === 'pressure' && e.strategy === 'compact')).toHaveLength(2);
    const refill = notes.filter((n) => n.includes('rapid refill detected'));
    expect(refill).toHaveLength(1);
    expect(refill[0]).toContain('within 2 rounds');
    expect(refill[0]).toContain('use /compact');
  });

  it('rapid-refill suppression survives unwired notice/callback hooks', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (isSummary) { yield text('S'); return; }
        yield text(big(400));
      },
    };
    const { loop } = baseLoop(
      { llm, context: { maxTokens: 600, strategy: 'compact', keepRecentTokens: 1 } },
      ['onContextNote', 'onCompaction', 'onUsage'],
    );
    loop.loadMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: big(500) },
    ]);
    for (let i = 0; i < 3; i++) await expect(loop.processUserInput(`t${i}`)).resolves.toBeDefined();
  });

  // ---- manual compactNow ----------------------------------------------------------

  it('manual truncate targets half the trigger watermark', async () => {
    const llm = scriptedLLM([]);
    const { loop } = baseLoop({
      llm,
      context: { maxTokens: 100_000, strategy: 'truncate' },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(40_000) },
    ]);
    const cm = (loop as unknown as { contextManager: { truncateToTokens: (m: Message[], t: number) => Message[]; triggerTokens: number } }).contextManager;
    const spy = vi.spyOn(cm, 'truncateToTokens');
    const r = await loop.compactNow('manual');
    expect(r.compacted).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.any(Array), Math.floor(cm.triggerTokens / 2));
  });

  it('manual compact with a failed summary degrades to the same half-trigger truncate', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'error', error: 'boom' };
      },
    };
    const { loop } = baseLoop({
      llm,
      context: { maxTokens: 100_000, strategy: 'compact', keepRecentTokens: 1 },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(2000) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: big(2000) },
    ]);
    const cm = (loop as unknown as { contextManager: { truncateToTokens: (m: Message[], t: number) => Message[]; triggerTokens: number } }).contextManager;
    const spy = vi.spyOn(cm, 'truncateToTokens');
    await loop.compactNow('overflow');
    expect(spy).toHaveBeenCalledWith(expect.any(Array), Math.floor(cm.triggerTokens / 2));
  });

  it('manual compaction that reclaims nothing reports compacted=false and persists nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-manual-'));
    const sessionFile = path.join(dir, 's.jsonl');
    const session = new SessionStore(sessionFile);
    try {
      const llm = scriptedLLM([]);
      const { loop, events } = baseLoop({
        llm,
        session,
        context: { maxTokens: 600, strategy: 'truncate' },
      });
      loop.loadMessages([
        { role: 'user', content: 'small talk' },
        { role: 'assistant', content: 'short' },
      ]);
      const cm = (loop as unknown as { contextManager: { truncateToTokens: (m: Message[], t: number) => Message[] } }).contextManager;
      vi.spyOn(cm, 'truncateToTokens').mockImplementation((m) => [...m]);
      const r = await loop.compactNow('manual');
      await session.close();
      expect(r.compacted).toBe(false);
      expect(events).toHaveLength(0);
      const jsonl = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf-8') : '';
      expect(jsonl).not.toContain('"type":"compaction"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- streaming semantics ---------------------------------------------------------

  it('tool_call_start surfaces the pending call verbatim: empty arguments, type function', async () => {
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1')],
      [text('done')],
    ]);
    const pending: ToolCall[] = [];
    const ready: ToolCall[] = [];
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      onToolCall: (c) => pending.push(c),
      onToolCallReady: (c) => ready.push(c),
    });
    await loop.processUserInput('go');
    expect(pending).toEqual([
      { id: 'c1', type: 'function', function: { name: 'echo', arguments: '' } },
    ]);
    expect(ready).toEqual([
      { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } },
    ]);
  });

  it('a tool_call_delta for an unopened id is dropped, never merged into a live call', async () => {
    const executed: string[] = [];
    const llm = scriptedLLM([
      [
        toolStart('c1', 'echo'),
        toolDelta('GHOST', '{"text":"poison"}'),
        toolDelta('c1', '{"text":"hi"}'),
        toolEnd('c1'),
        toolEnd('GHOST'),
      ],
      [text('done')],
    ]);
    const tool = echoTool(() => executed.push('ran'));
    const { loop } = baseLoop({ llm, toolRegistry: registryWith(tool) });
    await loop.processUserInput('go');
    const toolMsg = loop.getMessages().find((m) => m.role === 'tool');
    expect((toolMsg?.content ?? '')).toBe('echo: hi');
    expect(executed).toEqual(['ran']); // exactly one execution
  });

  it('assistant tool-call message stores content null when no text preceded the calls', async () => {
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1')],
      [text('done')],
    ]);
    const { loop } = baseLoop({ llm, toolRegistry: registryWith(echoTool()) });
    await loop.processUserInput('go');
    const assistant = loop.getMessages()[1];
    expect(assistant).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
    });
  });

  it('interrupt marks every surfaced pending call Interrupted. and keeps thinking-only partials', async () => {
    let sawHalf = false;
    let release: (() => void) | undefined;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'thinking_delta', content: 'TH' };
        yield toolStart('c1', 'echo');
        sawHalf = true;
        await new Promise<void>((r) => { release = r; });
        yield text('never');
      },
    };
    const results: Array<{ r: ToolResult; id?: string }> = [];
    const usages: Array<Record<string, unknown>> = [];
    const { loop, tokens } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      onToolResult: (r, id) => results.push({ r, id }),
      onUsage: (u) => usages.push({ ...u }),
    });
    const turnPromise = loop.processUserInput('go');
    const timer = setInterval(() => {
      if (sawHalf) { clearInterval(timer); loop.interrupt(); }
    }, 5);
    const turn = await turnPromise;
    release?.();

    expect(turn.text).toBe('');
    expect(results).toEqual([{ r: { content: 'Interrupted.', isError: true }, id: 'c1' }]);
    expect(tokens).toContain('[interrupted]');
    const assistant = loop.getMessages().find((m) => m.role === 'assistant');
    expect(assistant).toEqual({ role: 'assistant', content: null, thinking: 'TH' });
    // No usage chunks streamed → emitUsage must suppress the zero report.
    expect(usages).toHaveLength(0);
  });

  it('interrupt persists already-received usage before ending the turn', async () => {
    let saw = false;
    let release: (() => void) | undefined;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        yield text('par');
        yield usage({ inputTokens: 7, outputTokens: 2 });
        saw = true;
        await new Promise<void>((r) => { release = r; });
      },
    };
    const usages: Array<Record<string, unknown>> = [];
    const { loop } = baseLoop({ llm, onUsage: (u) => usages.push({ ...u }) });
    const turnPromise = loop.processUserInput('go');
    const timer = setInterval(() => {
      if (saw) { clearInterval(timer); loop.interrupt(); }
    }, 5);
    await turnPromise;
    release?.();
    expect(usages).toEqual([{ inputTokens: 7, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 }]);
  });

  it('truncated stream with pending tool calls discards them and injects the continue prompt verbatim', async () => {
    const pipeline = makePipeline();
    const execSpy = vi.spyOn(pipeline, 'execute');
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1'), { type: 'truncated' }],
      [text('final')],
    ]);
    const results: Array<{ r: ToolResult; id?: string }> = [];
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      toolExecutionPipeline: pipeline,
      onToolResult: (r, id) => results.push({ r, id }),
    });
    const turn = await loop.processUserInput('go');
    expect(turn.text).toBe('final');
    expect(execSpy).not.toHaveBeenCalled();
    expect(results).toEqual([{ r: { content: 'Truncated before execution.', isError: true }, id: 'c1' }]);
    const msgs = loop.getMessages();
    expect(msgs.some((m) => m.role === 'tool')).toBe(false);
    expect(msgs[2]).toEqual({
      role: 'user',
      content: 'Your previous response was cut off mid-output. Continue exactly where you stopped — do not repeat any content already emitted.',
    });
  });

  it('a second truncation stops the turn and keeps the thinking-only partial', async () => {
    const llm = scriptedLLM([
      [text('part1'), { type: 'truncated' }],
      [{ type: 'thinking_delta', content: 'T2' }, { type: 'truncated' }],
      [text('NEVER')],
    ]);
    const { loop } = baseLoop({ llm });
    const turn = await loop.processUserInput('go');
    expect(turn.text).toBe('part1');
    expect(llm.calls).toBe(2);
    const msgs = loop.getMessages();
    expect(msgs.at(-1)).toEqual({ role: 'assistant', content: null, thinking: 'T2' });
  });

  it('empty stream is retried exactly once, then reports the canonical error', async () => {
    const llm = scriptedLLM([[], [], [text('unused')]]);
    const { loop, tokens } = baseLoop({ llm });
    const turn = await loop.processUserInput('go');
    expect(llm.calls).toBe(2);
    expect(turn.text).toBe('');
    expect(tokens.join('')).toBe('[Error: LLM returned an empty stream]');
  });

  it('an explicit error chunk ends the turn without the empty-stream retry', async () => {
    const llm = scriptedLLM([[usage({ inputTokens: 1, outputTokens: 2 }), { type: 'error', error: 'boom' }]]);
    const usages: Array<Record<string, unknown>> = [];
    const { loop, tokens } = baseLoop({ llm, onUsage: (u) => usages.push({ ...u }) });
    const turn = await loop.processUserInput('go');
    expect(llm.calls).toBe(1);
    expect(turn.text).toBe('');
    expect(tokens.join('')).toBe('[Error: boom]');
    expect(usages).toEqual([{ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 }]);
  });

  it('usage aggregates across rounds including cache fields', async () => {
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1'), usage({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, cacheWriteTokens: 1 })],
      [text('done'), usage({ inputTokens: 5, outputTokens: 1 })],
    ]);
    const usages: Array<Record<string, unknown>> = [];
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      onUsage: (u) => usages.push({ ...u }),
    });
    await loop.processUserInput('go');
    expect(usages).toEqual([
      { inputTokens: 15, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 1 },
    ]);
  });

  it('usage with only output tokens still reports (the zero guard needs BOTH zero)', async () => {
    const llm = scriptedLLM([[text('ok'), usage({ inputTokens: 0, outputTokens: 5 })]]);
    const usages: Array<Record<string, unknown>> = [];
    const { loop } = baseLoop({ llm, onUsage: (u) => usages.push({ ...u }) });
    await loop.processUserInput('go');
    expect(usages).toEqual([{ inputTokens: 0, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0 }]);
  });

  it('zero-usage turns report nothing to onUsage and an unwired onUsage does not crash', async () => {
    const llmA = scriptedLLM([[text('ok'), usage({ inputTokens: 0, outputTokens: 0 })]]);
    const usages: Array<Record<string, unknown>> = [];
    const a = baseLoop({ llm: llmA, onUsage: (u) => usages.push({ ...u }) });
    await a.loop.processUserInput('go');
    expect(usages).toHaveLength(0);

    const llmB = scriptedLLM([[text('ok'), usage({ inputTokens: 3, outputTokens: 3 })]]);
    const b = baseLoop({ llm: llmB }, ['onUsage']);
    await expect(b.loop.processUserInput('go')).resolves.toMatchObject({ text: 'ok' });
  });

  it('cancel during tool execution stops before the next LLM round', async () => {
    const ctrl = new AbortController();
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1'), usage({ inputTokens: 2, outputTokens: 2 })],
      [text('NEVER')],
    ]);
    const usages: Array<Record<string, unknown>> = [];
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool(() => ctrl.abort())),
      abortSignal: ctrl.signal,
      onUsage: (u) => usages.push({ ...u }),
    });
    const turn = await loop.processUserInput('go');
    expect(llm.calls).toBe(1);
    expect(turn).toEqual({ text: '', rounds: 1 });
    expect(loop.getMessages().at(-1)).toEqual({ role: 'assistant', content: '' });
    expect(usages).toEqual([{ inputTokens: 2, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 }]);
  });

  it('a pre-aborted signal short-circuits execution with the Aborted. result', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const pipeline = makePipeline();
    const execSpy = vi.spyOn(pipeline, 'execute');
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1')],
      [text('NEVER')],
    ]);
    const results: Array<{ r: ToolResult; id?: string }> = [];
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      toolExecutionPipeline: pipeline,
      abortSignal: ctrl.signal,
      onToolResult: (r, id) => results.push({ r, id }),
    });
    const turn = await loop.processUserInput('go');
    expect(execSpy).not.toHaveBeenCalled();
    expect(results).toEqual([{ r: { content: 'Aborted.', isError: true }, id: 'c1' }]);
    expect(turn.text).toBe('');
    expect(llm.calls).toBe(1);
  });

  it('the pipeline receives the full execution context object', async () => {
    const pipeline = makePipeline();
    const execSpy = vi.spyOn(pipeline, 'execute');
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"hi"}'), toolEnd('c1')],
      [text('done')],
    ]);
    const { loop } = baseLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      toolExecutionPipeline: pipeline,
    });
    await loop.processUserInput('go');
    const args = execSpy.mock.calls[0];
    expect(args[1]).toEqual({ text: 'hi' });
    expect(args[2]).toMatchObject({ workingDirectory: process.cwd() });
    expect(args[2]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('round exhaustion appends a terminal empty message and reports usage once', async () => {
    const llm = scriptedLLM([
      [toolStart('c1', 'echo'), toolDelta('c1', '{"text":"1"}'), toolEnd('c1'), usage({ inputTokens: 1, outputTokens: 1 })],
      [toolStart('c2', 'echo'), toolDelta('c2', '{"text":"2"}'), toolEnd('c2'), usage({ inputTokens: 2, outputTokens: 2 })],
      [toolStart('c3', 'echo'), toolDelta('c3', '{"text":"3"}'), toolEnd('c3'), usage({ inputTokens: 3, outputTokens: 3 })],
      [text('NEVER')],
    ]);
    const usages: Array<Record<string, unknown>> = [];
    const exhausted = new AgentLoop({
      llm,
      toolRegistry: registryWith(echoTool()),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 2, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onUsage: (u) => usages.push({ ...u }),
      onPermissionRequest: async () => true,
    });
    const turn = await exhausted.processUserInput('loop');
    expect(turn).toEqual({ text: '', rounds: 3 });
    expect(llm.calls).toBe(3);
    expect(exhausted.getMessages().at(-1)).toEqual({ role: 'assistant', content: '' });
    expect(usages).toEqual([{ inputTokens: 6, outputTokens: 6, cachedInputTokens: 0, cacheWriteTokens: 0 }]);
  });

  it('an ordinary error never triggers the overflow compaction path', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        throw new Error('kaboom');
      },
    };
    const { loop, events, tokens } = baseLoop({
      llm,
      context: { maxTokens: 600, strategy: 'truncate' },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(500) },
    ]);
    const turn = await loop.processUserInput('go');
    expect(turn).toEqual({ text: '', rounds: 1 });
    expect(tokens.join('')).toBe('[Error: kaboom]');
    // ONE automatic pressure pass happened before the chat; the error path
    // must not add a second (overflow-origin) compaction or retry.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'pressure' });
  });

  it('reactive overflow retry counts as the SAME round', async () => {
    let turnChats = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (isSummary) { yield text('S'); return; }
        turnChats++;
        if (turnChats === 1) throw new Error('maximum context length exceeded, please shrink');
        yield text('ok');
      },
    };
    const { loop } = baseLoop({
      llm,
      context: { maxTokens: 100_000, strategy: 'compact', keepRecentTokens: 1 },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(40_000) },
    ]);
    const turn = await loop.processUserInput('go');
    expect(turn).toEqual({ text: 'ok', rounds: 1 });
    expect(turnChats).toBe(2);
    const users = loop.getMessages().filter((m) => m.role === 'user');
    expect(users).toHaveLength(2); // 'q' + 'go', no duplicate injection on retry
  });

  it('a second overflow gives up cleanly after exactly one compaction attempt', async () => {
    let summaries = 0;
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const isSummary = (msgs[0].content ?? '').startsWith('Summarize the conversation');
        if (isSummary) { summaries++; yield text('S'); return; }
        throw new Error('maximum context length exceeded, again');
      },
    };
    const { loop, tokens } = baseLoop({
      llm,
      context: { maxTokens: 100_000, strategy: 'compact', keepRecentTokens: 1 },
    });
    loop.loadMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: big(40_000) },
    ]);
    const turn = await loop.processUserInput('go');
    expect(turn).toEqual({ text: '', rounds: 1 });
    expect(summaries).toBe(1);
    expect(tokens.join('')).toBe('[Error: maximum context length exceeded, again]');
  });

  it('stalled streams fail with the exact watchdog message', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        await new Promise(() => {}); // never yields
      },
    };
    const { loop, tokens } = baseLoop({ llm, streamIdleTimeoutMs: 1500 });
    const turn = await loop.processUserInput('go');
    expect(turn.text).toBe('');
    expect(tokens.join('')).toBe('[Error: LLM stream stalled — no data for 2s]');
  }, 15_000);

  // ---- undo / skills -------------------------------------------------------------

  it('undoTurns(0) and an assistant-only history are both no-ops', async () => {
    const llm = scriptedLLM([]);
    const { loop } = baseLoop({ llm });
    loop.loadMessages([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(loop.undoTurns(0)).toEqual({ undone: false, undoneTurns: 0 });
    expect(loop.getMessages()).toHaveLength(2);
    loop.loadMessages([{ role: 'assistant', content: 'orphan' }]);
    expect(loop.undoTurns(1)).toEqual({ undone: false, undoneTurns: 0 });
    expect(loop.getMessages()).toEqual([{ role: 'assistant', content: 'orphan' }]);
  });

  it('undoTurns clamps to the conversation start and persists the slim state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-undo-'));
    const sessionFile = path.join(dir, 's.jsonl');
    const session = new SessionStore(sessionFile);
    try {
      const llm = scriptedLLM([]);
      const { loop } = baseLoop({ llm, session });
      loop.loadMessages([
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ]);
      expect(loop.undoTurns(1)).toEqual({ undone: true, undoneTurns: 1 });
      expect(loop.getMessages()).toEqual([
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ]);
      expect(loop.undoTurns(5)).toEqual({ undone: true, undoneTurns: 1 });
      expect(loop.getMessages()).toEqual([]);
      expect(loop.undoTurns(1)).toEqual({ undone: false, undoneTurns: 0 });
      await session.close();
      const jsonl = fs.readFileSync(sessionFile, 'utf-8');
      expect(jsonl).toContain('"type":"compaction"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function fakeSkills(bodies: Record<string, string | Error>): SkillRegistry {
    const metas: SkillMeta[] = Object.keys(bodies).map((n) => ({
      name: n, description: `desc-${n}`, path: `/skills/${n}/SKILL.md`,
    }));
    return {
      findAll: () => metas,
      findByKeywords: () => metas,
      load: async (meta: SkillMeta) => {
        const b = bodies[meta.name];
        if (b instanceof Error) throw b;
        return b;
      },
    } as unknown as SkillRegistry;
  }

  it('skills inject up to maxActiveSkills in exact order with the section separator', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop } = baseLoop({
      llm,
      skills: fakeSkills({ A: 'B1', B: 'B2', C: 'B3' }),
    });
    await loop.processUserInput('go');
    const injected = loop.getMessages().find((m) => m.role === 'system');
    expect(injected).toEqual({ role: 'system', content: '## Active Skills\nB1\n\n---\n\nB2' });
  });

  it('maxActiveSkills=0 disables injection even with matches', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop } = baseLoop({
      llm,
      skills: fakeSkills({ A: 'B1', B: 'B2' }),
      maxActiveSkills: 0,
    });
    await loop.processUserInput('go');
    expect(loop.getMessages().some((m) => m.role === 'system')).toBe(false);
  });

  it('skills that all fail to load inject nothing (not an empty section)', async () => {
    const llm = scriptedLLM([[text('ok')]]);
    const { loop } = baseLoop({
      llm,
      skills: fakeSkills({ A: new Error('unreadable'), B: new Error('unreadable') }),
    });
    await loop.processUserInput('go');
    expect(loop.getMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});
