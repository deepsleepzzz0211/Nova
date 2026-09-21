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
import type { ThinkingLevel } from '../../src/llm/compat.js';
import type { ChatOptions, Message, StreamChunk } from '../../src/llm/types.js';
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
    const { provider, capture, faux } = makeFaux(false);
    const chunks = await run(provider, 'high');
    expect(capture.reasoning).toBeUndefined();
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    void faux;
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
