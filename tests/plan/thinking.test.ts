import { describe, it, expect } from 'vitest';
import {
  fauxProvider,
  fauxAssistantMessage,
  type FauxProviderHandle,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createPiaiEngine, type PiaiEngine } from '../../src/llm/piai-engine.js';
import { PiProvider, resolvePiReasoning } from '../../src/llm/providers/piai.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { ChatOptions, Message, StreamChunk, ThinkingLevel } from '../../src/llm/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';

/**
 * Ticket 04 — thinking levels. Nova's unified thinkingLevel maps to pi-ai
 * reasoning via the model's OWN capability: pi-ai clamps/degrades, so we no
 * longer hand-roll a level map. Non-reasoning models must silently omit the
 * parameter (no request error); xhigh/max only survive when the model
 * advertises them (via thinkingLevelMap).
 */

function modelFor(over: Partial<Model<string>> = {}): Model<string> {
  return {
    id: 'm',
    name: 'm',
    api: 'openai-completions',
    provider: 'p',
    baseUrl: 'https://x.invalid',
    reasoning: true,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over,
  } as Model<string>;
}

describe('resolvePiReasoning (pi-ai model-capability clamping)', () => {
  it('off and undefined send nothing', () => {
    const m = modelFor();
    expect(resolvePiReasoning(m, 'off')).toBeUndefined();
    expect(resolvePiReasoning(m, undefined)).toBeUndefined();
  });

  it('standard levels pass through on a reasoning model', () => {
    const m = modelFor();
    for (const level of ['minimal', 'low', 'medium', 'high'] as ThinkingLevel[]) {
      expect(resolvePiReasoning(m, level)).toBe(level);
    }
  });

  it('a non-reasoning model drops any level (silent ignore, no error)', () => {
    const m = modelFor({ reasoning: false });
    expect(resolvePiReasoning(m, 'high')).toBeUndefined();
    expect(resolvePiReasoning(m, 'max')).toBeUndefined();
  });

  it('xhigh/max are degraded to the nearest supported level by default', () => {
    // Default reasoning model advertises only up to 'high'.
    const m = modelFor();
    expect(resolvePiReasoning(m, 'xhigh')).toBe('high');
    expect(resolvePiReasoning(m, 'max')).toBe('high');
  });

  it('xhigh/max pass IN PLACE only when the model maps them', () => {
    const withMap = modelFor({ thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } as never });
    expect(resolvePiReasoning(withMap, 'xhigh')).toBe('xhigh');
    expect(resolvePiReasoning(withMap, 'max')).toBe('max');
  });

  it('a null map entry marks the level unsupported (clamped away)', () => {
    const m = modelFor({ thinkingLevelMap: { high: null } as never });
    // 'high' unsupported → nearest supported at-or-below the requested slot
    expect(resolvePiReasoning(m, 'high')).toBe('medium');
  });
});

// --- end-to-end through PiProvider.streamSimple -----------------------------

interface Captured {
  reasoning?: string;
}

function makeFaux(reasoning: boolean): {
  engine: PiaiEngine;
  faux: FauxProviderHandle;
  capture: Captured;
  provider: PiProvider;
} {
  const engine = createPiaiEngine();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'fx', reasoning }],
  });
  engine.models.setProvider(faux.provider);
  const capture: Captured = {};
  const step = (
    _ctx: Context,
    options: SimpleStreamOptions | undefined,
  ) => {
    capture.reasoning = options?.reasoning;
    return fauxAssistantMessage('ok');
  };
  faux.setResponses([step]);
  const provider = new PiProvider({ engine, provider: 'faux', model: 'fx', apiKey: 'k' });
  return { engine, faux, capture, provider };
}

async function run(provider: PiProvider, thinkingLevel: ThinkingLevel): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  const msgs: Message[] = [{ role: 'user', content: 'hi' }];
  for await (const c of provider.chat(msgs, { model: 'fx', thinkingLevel })) out.push(c);
  return out;
}

describe('PiProvider forwards model-clamped reasoning to pi-ai', () => {
  it('a reasoning model receives the requested standard level', async () => {
    const { provider, capture } = makeFaux(true);
    const chunks = await run(provider, 'high');
    expect(capture.reasoning).toBe('high');
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });

  it('a reasoning model degrades xhigh to its supported ceiling instead of erroring', async () => {
    const { provider, capture } = makeFaux(true);
    await run(provider, 'xhigh');
    expect(capture.reasoning).toBe('high');
  });

  it('a non-reasoning model omits reasoning entirely (no request error)', async () => {
    const { provider, capture } = makeFaux(false);
    const chunks = await run(provider, 'high');
    expect(capture.reasoning).toBeUndefined();
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });
});

// --- AgentLoop still forwards thinkingLevel into ChatOptions ----------------

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

describe('AgentLoop forwards thinkingLevel to ChatOptions', () => {
  it('passes the configured level into every chat call', async () => {
    const opts: ChatOptions[] = [];
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(_msgs: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
        opts.push(options);
        yield { type: 'text_delta', content: 'ok' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 10, model: 'test' },
      thinkingLevel: 'high',
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    await loop.processUserInput('hi');
    expect(opts[0].thinkingLevel).toBe('high');
  });
});

// p1-p2 12 (kill test): thinking deltas must not require an onThinking
// callback — the accumulator forwards through ?. and a provider can emit
// reasoning to a loop configured without one (print mode, scripts).
describe('AgentLoop tolerates thinking deltas without an onThinking callback', () => {
  it('consumes a thinking_delta stream and completes normally', async () => {
    const llm: LLMProvider = {
      name: 'fake',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'thinking_delta', content: 'reasoning ' };
        yield { type: 'thinking_delta', content: 'done' };
        yield { type: 'text_delta', content: 'answer' };
      },
    };
    const tokens: string[] = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: (t) => tokens.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    const result = await loop.processUserInput('hi');
    expect(result.text).toBe('answer');
    expect(result.rounds).toBe(1);
    const history = loop.getMessages();
    const assistant = history[history.length - 1];
    expect(assistant.role).toBe('assistant');
    if (assistant.role === 'assistant') {
      expect(assistant.thinking).toBe('reasoning done');
    }
  });
});
