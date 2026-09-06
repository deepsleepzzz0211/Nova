import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadModelCatalog,
  resolveModel,
  BUILTIN_PROVIDER_API,
} from '../../src/llm/catalog.js';

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

describe('ModelCatalog built-in defaults', () => {
  it('resolves built-in providers without any user file', () => {
    const catalog = loadModelCatalog([]);
    const r = resolveModel({ provider: 'openai', model: 'gpt-4o' }, catalog);
    expect(r.api).toBe('openai-completions');
    expect(r.baseUrl).toBe('https://api.openai.com/v1');
    expect(r.model.id).toBe('gpt-4o');
    expect(r.model.contextWindow).toBeGreaterThan(0);

    const a = resolveModel({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }, catalog);
    expect(a.api).toBe('anthropic-messages');

    const o = resolveModel({ provider: 'ollama', model: 'llama3' }, catalog);
    expect(o.api).toBe('ollama');
  });

  it('synthesizes a default model entry for unknown model ids', () => {
    const catalog = loadModelCatalog([]);
    const r = resolveModel({ provider: 'openai', model: 'gpt-5-turbo-future' }, catalog);
    expect(r.model.id).toBe('gpt-5-turbo-future');
    expect(r.api).toBe('openai-completions');
    expect(r.model.contextWindow).toBe(128_000); // sane default
  });

  it('exposes the api id for every built-in provider', () => {
    expect(BUILTIN_PROVIDER_API.openai).toBe('openai-completions');
    expect(BUILTIN_PROVIDER_API.anthropic).toBe('anthropic-messages');
    expect(BUILTIN_PROVIDER_API.ollama).toBe('ollama');
  });
});

describe('ModelCatalog user file', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-catalog-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a user provider and resolves its models', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        'my-vllm': {
          baseUrl: 'http://localhost:8000/v1',
          api: 'openai-completions',
          models: [{ id: 'qwen2.5-coder:7b', contextWindow: 32768 }],
        },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const r = resolveModel({ provider: 'my-vllm', model: 'qwen2.5-coder:7b' }, catalog);
    expect(r.api).toBe('openai-completions');
    expect(r.baseUrl).toBe('http://localhost:8000/v1');
    expect(r.model.contextWindow).toBe(32768);
  });

  it('redirects a built-in provider via baseUrl while keeping its models', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        anthropic: { baseUrl: 'https://my-proxy.example.com' },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const r = resolveModel(
      { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
      catalog,
    );
    expect(r.baseUrl).toBe('https://my-proxy.example.com');
    expect(r.model.id).toBe('claude-3-5-sonnet-20241022'); // built-in model kept
    expect(r.api).toBe('anthropic-messages');
  });

  it('upserts user models by id and adds new ones alongside built-ins', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        openai: {
          models: [
            // replaces the built-in gpt-4o entry
            { id: 'gpt-4o', contextWindow: 999_999 },
            // new model alongside built-ins
            { id: 'gpt-5x', contextWindow: 400_000, reasoning: true },
          ],
        },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const replaced = resolveModel({ provider: 'openai', model: 'gpt-4o' }, catalog);
    expect(replaced.model.contextWindow).toBe(999_999);

    const added = resolveModel({ provider: 'openai', model: 'gpt-5x' }, catalog);
    expect(added.model.contextWindow).toBe(400_000);
    expect(added.model.reasoning).toBe(true);
  });

  it('merges compat flags: provider-level base, model-level override', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        'my-vllm': {
          baseUrl: 'http://x/v1',
          api: 'openai-completions',
          compat: { supportsDeveloperRole: false, streamUsage: true },
          models: [
            { id: 'm1' },
            { id: 'm2', compat: { streamUsage: false } },
          ],
        },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    expect(resolveModel({ provider: 'my-vllm', model: 'm1' }, catalog).model.compat).toEqual({
      supportsDeveloperRole: false,
      streamUsage: true,
    });
    expect(resolveModel({ provider: 'my-vllm', model: 'm2' }, catalog).model.compat).toEqual({
      supportsDeveloperRole: false,
      streamUsage: false,
    });
  });

  it('treats promptCache as a deprecated alias of streamUsage', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        p: {
          baseUrl: 'http://x/v1',
          api: 'openai-completions',
          compat: { promptCache: true },
        },
      },
    });
    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    expect(resolveModel({ provider: 'p', model: 'any' }, catalog).model.compat.streamUsage).toBe(true);
  });

  it('applies modelOverrides to built-in models without replacing them', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        openai: {
          modelOverrides: {
            // Only widen the window; other fields/pricing stay intact
            'gpt-4o': { contextWindow: 1_050_000 },
            // Unknown ids are ignored
            'no-such-model': { contextWindow: 1 },
          },
        },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const overridden = resolveModel({ provider: 'openai', model: 'gpt-4o' }, catalog);
    expect(overridden.model.contextWindow).toBe(1_050_000);

    // Sibling models untouched
    const sibling = resolveModel({ provider: 'openai', model: 'gpt-4o-mini' }, catalog);
    expect(sibling.model.contextWindow).toBe(128_000);
  });

  it('merges override compat per key with the model compat', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        p: {
          baseUrl: 'http://x/v1',
          api: 'openai-completions',
          models: [{ id: 'm1', compat: { supportsDeveloperRole: true, streamUsage: false } }],
          modelOverrides: {
            m1: { compat: { streamUsage: true } },
          },
        },
      },
    });

    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const r = resolveModel({ provider: 'p', model: 'm1' }, catalog);
    expect(r.model.compat).toEqual({ supportsDeveloperRole: true, streamUsage: true });
  });

  it('lets a model override the provider api', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        gateway: {
          baseUrl: 'http://gw/v1',
          api: 'openai-completions',
          models: [{ id: 'claude-x', api: 'anthropic-messages' }],
        },
      },
    });
    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    expect(resolveModel({ provider: 'gateway', model: 'claude-x' }, catalog).api).toBe('anthropic-messages');
  });

  it('explicit overrides (config/env/CLI) win over the catalog', () => {
    writeJson(path.join(dir, 'models.json'), {
      providers: {
        openai: { baseUrl: 'https://proxy.example.com/v1' },
      },
    });
    const catalog = loadModelCatalog([path.join(dir, 'models.json')]);
    const r = resolveModel(
      {
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://cli-override.example.com/v1',
        apiKey: 'sk-cli',
      },
      catalog,
    );
    expect(r.baseUrl).toBe('https://cli-override.example.com/v1');
    expect(r.apiKey).toBe('sk-cli');
  });

  it('throws for an unknown provider with no built-in fallback', () => {
    const catalog = loadModelCatalog([]);
    expect(() => resolveModel({ provider: 'nope', model: 'm' }, catalog)).toThrow(/Unknown provider/);
  });

  it('ignores malformed user files', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    const catalog = loadModelCatalog([path.join(dir, 'bad.json')]);
    // Built-ins still work
    const r = resolveModel({ provider: 'openai', model: 'gpt-4o' }, catalog);
    expect(r.api).toBe('openai-completions');
  });
});
