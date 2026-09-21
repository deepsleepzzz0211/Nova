import { describe, it, expect, afterEach } from 'vitest';
import {
  createProvider,
  createAssistantMessageEventStream,
  envApiKeyAuth,
  fauxAssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createPiaiEngine, type PiaiEngine } from '../../src/llm/piai-engine.js';
import { PiProvider } from '../../src/llm/providers/piai.js';
import type { Message } from '../../src/llm/types.js';

/**
 * Ticket 05 (option A) — Nova's already-resolved key (secrets.ts DSL, config,
 * env, CLI) is injected as pi-ai's per-request apiKey (explicit wins); when
 * Nova has NO explicit key the parameter is omitted so pi-ai's own env /
 * CredentialStore / OAuth auth resolves. An empty/whitespace key counts as
 * "not provided" (Nova's default config uses apiKey: '').
 */

const MODEL: Model<string> = {
  id: 'authm',
  name: 'authm',
  api: 'auth-api',
  provider: 'authtest',
  baseUrl: 'http://x.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

interface Seen {
  apiKey?: string;
}

function makeEngineEnvAuth(envVar: string): { engine: PiaiEngine; seen: Seen } {
  const seen: Seen = {};
  const engine = createPiaiEngine();
  engine.models.setProvider(
    createProvider({
      id: 'authtest',
      auth: { apiKey: envApiKeyAuth('AuthTest', [envVar]) },
      models: [MODEL],
      api: {
        stream: () => {
          throw new Error('unused');
        },
        streamSimple: (_m, _c: Context, options?: SimpleStreamOptions) => {
          seen.apiKey = options?.apiKey;
          const s = createAssistantMessageEventStream();
          const msg = fauxAssistantMessage('ok');
          s.push({ type: 'done', reason: 'stop', message: msg });
          s.end(msg);
          return s as AssistantMessageEventStream;
        },
      },
    }),
  );
  return { engine, seen };
}

async function chat(provider: PiProvider): Promise<void> {
  const msgs: Message[] = [{ role: 'user', content: 'hi' }];
  const it = provider.chat(msgs, { model: MODEL.id })[Symbol.asyncIterator]();
  while (!(await it.next()).done) {
    /* drain until done */
  }
}

const saved = process.env.NOVA_AUTHTEST_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.NOVA_AUTHTEST_KEY;
  else process.env.NOVA_AUTHTEST_KEY = saved;
});

describe('PiProvider auth precedence', () => {
  it('injects an explicit Nova-resolved key as the request apiKey', async () => {
    const { engine, seen } = makeEngineEnvAuth('NOVA_AUTHTEST_KEY');
    process.env.NOVA_AUTHTEST_KEY = 'sk-from-env';
    const provider = new PiProvider({
      engine,
      provider: 'authtest',
      model: MODEL.id,
      apiKey: 'sk-explicit',
    });
    await chat(provider);
    expect(seen.apiKey).toBe('sk-explicit'); // explicit beats env
  });

  it('forwards a non-blank key RAW (blankness detected, value untouched)', async () => {
    const { engine, seen } = makeEngineEnvAuth('NOVA_AUTHTEST_KEY');
    process.env.NOVA_AUTHTEST_KEY = 'sk-from-env';
    const provider = new PiProvider({
      engine,
      provider: 'authtest',
      model: MODEL.id,
      apiKey: '  sk-padded  ',
    });
    await chat(provider);
    // Only all-whitespace counts as absent; a real key is not trimmed.
    expect(seen.apiKey).toBe('  sk-padded  ');
  });

  it('omits the key when Nova has none, so pi-ai env auth resolves', async () => {
    const { engine, seen } = makeEngineEnvAuth('NOVA_AUTHTEST_KEY');
    process.env.NOVA_AUTHTEST_KEY = 'sk-from-env';
    const provider = new PiProvider({ engine, provider: 'authtest', model: MODEL.id });
    await chat(provider);
    // Models.streamSimple injects the resolved env auth into provider options.
    expect(seen.apiKey).toBe('sk-from-env');
  });

  it('treats an empty-string key as absent (default config apiKey: "")', async () => {
    const { engine, seen } = makeEngineEnvAuth('NOVA_AUTHTEST_KEY');
    process.env.NOVA_AUTHTEST_KEY = 'sk-from-env';
    const provider = new PiProvider({
      engine,
      provider: 'authtest',
      model: MODEL.id,
      apiKey: '',
    });
    await chat(provider);
    expect(seen.apiKey).toBe('sk-from-env'); // NOT '' — fallback preserved
  });

  it('treats a whitespace-only key as absent', async () => {
    const { engine, seen } = makeEngineEnvAuth('NOVA_AUTHTEST_KEY');
    process.env.NOVA_AUTHTEST_KEY = 'sk-from-env';
    const provider = new PiProvider({
      engine,
      provider: 'authtest',
      model: MODEL.id,
      apiKey: '   ',
    });
    await chat(provider);
    expect(seen.apiKey).toBe('sk-from-env');
  });
});
