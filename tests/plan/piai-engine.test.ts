import { describe, it, expect } from 'vitest';
import {
  createPiaiEngine,
  type PiaiEngine,
  type PiaiModelDescriptor,
  type UserProviderSpec,
} from '../../src/llm/piai-engine.js';

/**
 * Ticket 01 — pi-ai engine integration.
 *
 * The engine builds the "Models collection = built-in providers + user
 * custom providers" source of truth backed by @earendil-works/pi-ai:
 *  - built-in openai / anthropic come from pi-ai's official factory providers
 *  - ollama has no pi-ai factory, so it is built as an OpenAI-compatible
 *    local provider via `createProvider`
 *  - user models.json custom providers are injected into the same collection
 *    via `createProvider`, so their models resolve exactly like built-ins
 */
describe('piai-engine collection', () => {
  it('exposes built-in openai and anthropic providers with resolvable models', () => {
    const engine: PiaiEngine = createPiaiEngine();

    expect(engine.getProvider('openai')).toBeDefined();
    expect(engine.getProvider('anthropic')).toBeDefined();

    const gpt4o = engine.getModel('openai', 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.contextWindow).toBeGreaterThan(0);

    const sonnet = engine.getModel('anthropic', 'claude-sonnet-4-5');
    expect(sonnet).toBeDefined();
  });

  it('provides OpenAI-compatible ollama as a built-in local provider', () => {
    const engine: PiaiEngine = createPiaiEngine();
    expect(engine.getProvider('ollama')).toBeDefined();
  });

  it('describes built-in provider model descriptors for the catalog', () => {
    const engine: PiaiEngine = createPiaiEngine();
    const models: PiaiModelDescriptor[] = engine.describeProviderModels('openai');
    expect(models.length).toBeGreaterThan(0);
    const gpt4o = models.find((m) => m.id === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.contextWindow).toBeGreaterThan(0);
  });

  it('lists known providers', () => {
    const engine: PiaiEngine = createPiaiEngine();
    const ids = engine.listProviders();
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
  });
});

describe('piai-engine user custom providers', () => {
  it('injects a user provider (models.json) into the same collection', () => {
    const engine: PiaiEngine = createPiaiEngine();
    engine.registerUserProvider({
      id: 'my-vllm',
      name: 'My vLLM',
      baseUrl: 'http://localhost:8000/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'qwen2.5-coder:7b',
          contextWindow: 32768,
          maxTokens: 8192,
          reasoning: false,
        },
      ],
    });

    expect(engine.getProvider('my-vllm')).toBeDefined();
    const m = engine.getModel('my-vllm', 'qwen2.5-coder:7b');
    expect(m).toBeDefined();
    expect(m!.contextWindow).toBe(32768);
  });
});