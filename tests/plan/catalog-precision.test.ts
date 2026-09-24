import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadModelCatalogWithEngine,
  resolveModel,
  parseModelSpec,
  describeModels,
  defaultContextWindow,
  BUILTIN_PROVIDERS,
} from '../../src/llm/catalog.js';
import type { CompatFlags, ModelCatalog } from '../../src/llm/catalog.js';
import { PiaiEngine } from '../../src/llm/piai-engine.js';

// survived-hunt (test-effectiveness 03), cluster 3/3: src/llm/catalog.ts.
// Pins the compat-flag normalization matrix, the merge/registration path
// against the REAL engine, and the exact /model listing rendering.

function compatOf(flags?: CompatFlags): { supportsDeveloperRole: boolean; streamUsage: boolean } {
  const catalog: ModelCatalog = {
    providers: {
      p: { api: 'openai-completions', ...(flags ? { compat: flags } : {}), models: [{ id: 'm' }] },
    },
  };
  return resolveModel({ provider: 'p', model: 'm' }, catalog).model.compat;
}

describe('normalizeCompat matrix (resolveModel surface)', () => {
  it('absent flags normalize to both-false without dereferencing undefined', () => {
    expect(compatOf(undefined)).toEqual({ supportsDeveloperRole: false, streamUsage: false });
  });

  it('supportsDeveloperRole=true passes through, nothing else flips', () => {
    expect(compatOf({ supportsDeveloperRole: true })).toEqual({ supportsDeveloperRole: true, streamUsage: false });
  });

  it('streamUsage=true stands alone (no conjunction with the alias check)', () => {
    expect(compatOf({ streamUsage: true })).toEqual({ supportsDeveloperRole: false, streamUsage: true });
  });

  it('promptCache=true is the deprecated alias when streamUsage is absent', () => {
    expect(compatOf({ promptCache: true })).toEqual({ supportsDeveloperRole: false, streamUsage: true });
  });

  it('an explicit streamUsage=false wins over promptCache=true (alias only covers undefined)', () => {
    expect(compatOf({ streamUsage: false, promptCache: true })).toEqual({ supportsDeveloperRole: false, streamUsage: false });
  });

  it('supportsDeveloperRole=false is a real false, not undefined', () => {
    expect(compatOf({ supportsDeveloperRole: false })).toEqual({ supportsDeveloperRole: false, streamUsage: false });
  });
});

describe('defaultContextWindow / built-in table', () => {
  it('unknown providers fall back to 128000, built-ins carry their own windows', () => {
    expect(defaultContextWindow('no-such-provider')).toBe(128_000);
    expect(defaultContextWindow('anthropic')).toBe(200_000);
    expect(defaultContextWindow('ollama')).toBe(32_768);
    expect(BUILTIN_PROVIDERS.ollama.baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('parseModelSpec', () => {
  it('trims both halves and splits on the FIRST slash only', () => {
    expect(parseModelSpec('  my-proxy / gpt-4o/extra  ', 'cur')).toEqual({
      provider: 'my-proxy',
      model: 'gpt-4o/extra',
    });
    expect(parseModelSpec(' bare-id ', 'cur')).toEqual({ provider: 'cur', model: 'bare-id' });
    expect(parseModelSpec('', 'cur')).toEqual({ provider: 'cur', model: '' });
  });
});

describe('describeModels exact rendering', () => {
  it('renders the whole listing byte-exact: markers, display names, defaults, reasoning', () => {
    const catalog: ModelCatalog = {
      providers: {
        testp: {
          api: 'openai-completions',
          models: [
            { id: 'a', name: 'a' }, // name === id → no parens
            { id: 'b', name: 'B display', contextWindow: 1000 },
            { id: 'c', reasoning: true },
          ],
        },
      },
    };
    const expected = [
      'Provider: testp',
      `   a  ctx ${(128_000).toLocaleString()}`,
      ` * b  (B display)  ctx ${(1000).toLocaleString()}`,
      `   c  ctx ${(128_000).toLocaleString()}  [reasoning]`,
      '',
      'Switch with: /model <id>  or  /model <provider>/<id>',
    ].join('\n');
    expect(describeModels(catalog, 'testp', 'b')).toBe(expected);
  });

  it('non-current models never carry the star marker', () => {
    const catalog: ModelCatalog = {
      providers: { p2: { models: [{ id: 'solo' }] } },
    };
    const out = describeModels(catalog, 'p2', 'other');
    expect(out.split('\n')[1]).toBe(`   solo  ctx ${(128_000).toLocaleString()}`);
  });

  it('unknown providers report with the exact error line', () => {
    expect(describeModels({ providers: {} }, 'ghost', 'x')).toBe('Unknown provider: ghost');
  });
});

describe('user-file merge against the real pi-ai engine', () => {
  let dir: string;
  function writeModelFile(data: unknown): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  }

  function withTmp(fn: (file: (data: unknown) => string) => void): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cat-prec-'));
    try {
      fn((data) => writeModelFile(data));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a brand-new provider is registered into the engine AND the catalog', () => {
    withTmp((file) => {
      const path1 = file({
        providers: {
          custom: {
            baseUrl: 'http://x/v1',
            api: 'openai-completions',
            models: [{ id: 'm1', contextWindow: 5000 }, { id: 'm2' }],
          },
        },
      });
      const { catalog, engine } = loadModelCatalogWithEngine(new PiaiEngine(), [path1]);
      // Exact object shape: no junk keys from mutated base/array literals.
      expect(catalog.providers.custom).toEqual({
        baseUrl: 'http://x/v1',
        api: 'openai-completions',
        models: [
          { id: 'm1', contextWindow: 5000 },
          { id: 'm2', contextWindow: 128_000 },
        ],
      });
      expect(catalog.providers.custom.models?.map((m) => m.id)).toEqual(['m1', 'm2']);
      // The engine registration side-effect is observable through describe.
      const described = engine.describeProviderModels('custom');
      expect(described).toHaveLength(2);
      expect(described.find((m) => m.id === 'm1')?.contextWindow).toBe(5000);
    });
  });

  it('a models-less custom provider yields an empty engine spec, not junk entries', () => {
    withTmp((file) => {
      const p = file({ providers: { sparse: { baseUrl: 'http://y/v1', api: 'openai-completions' } } });
      const { catalog } = loadModelCatalogWithEngine(new PiaiEngine(), [p]);
      expect(catalog.providers.sparse.models ?? []).toEqual([]);
    });
  });

  it('built-in override keeps baseUrl/api/apiKey fields and is NOT re-registered into the engine', () => {
    withTmp((file) => {
      const p = file({
        providers: {
          openai: { modelOverrides: { 'gpt-4o': { contextWindow: 999 } } },
        },
      });
      const { catalog, engine } = loadModelCatalogWithEngine(new PiaiEngine(), [p]);
      expect(catalog.providers.openai.baseUrl).toBe('https://api.openai.com/v1');
      expect(catalog.providers.openai.api).toBe('openai-completions');
      const gpt = catalog.providers.openai.models?.find((m) => m.id === 'gpt-4o');
      expect(gpt?.contextWindow).toBe(999);
      // The built-in engine collection must survive untouched (no user
      // re-registration with an empty model spec).
      expect(engine.describeProviderModels('openai').length).toBeGreaterThan(3);
    });
  });

  it('a provider with no api anywhere fails with the no-api message', () => {
    const catalog: ModelCatalog = {
      providers: { noapi: { models: [{ id: 'x' }] } },
    };
    expect(() => resolveModel({ provider: 'noapi', model: 'x' }, catalog)).toThrow('no api configured');
  });

  it('a declared literal apiKey survives resolution when no explicit key is given', () => {
    const catalog: ModelCatalog = {
      providers: {
        keyed: { api: 'openai-completions', apiKey: 'sk-catalog-literal-9f3', models: [{ id: 'k' }] },
      },
    };
    const r = resolveModel({ provider: 'keyed', model: 'k' }, catalog);
    expect(r.apiKey).toBe('sk-catalog-literal-9f3');
    const explicit = resolveModel({ provider: 'keyed', model: 'k', apiKey: 'sk-explicit' }, catalog);
    expect(explicit.apiKey).toBe('sk-explicit');
    const none = resolveModel(
      { provider: 'noapi2', model: 'k' },
      { providers: { noapi2: { api: 'openai-completions', models: [] } } },
    );
    expect(none.apiKey).toBeUndefined();
  });

  it('custom provider without explicit baseUrl/api falls back to engine defaults per api', () => {
    withTmp((file) => {
      const p = file({ providers: { plain: { api: 'openai-completions', models: [{ id: 'pm' }] } } });
      const { catalog } = loadModelCatalogWithEngine(new PiaiEngine(), [p]);
      const r = resolveModel({ provider: 'plain', model: 'pm' }, catalog);
      expect(r.api).toBe('openai-completions');
      expect(r.model.contextWindow).toBe(128_000); // engine default for a fresh model
    });
  });
});
