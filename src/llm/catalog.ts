import * as fs from 'fs';
import type {
  ApiId,
  CompatFlags,
  NormalizedCompat,
  ThinkingLevel,
  ThinkingLevelMap,
} from './compat.js';
import { normalizeCompat } from './compat.js';
import { resolveSecretValue } from './secrets.js';
import { PiaiEngine, type UserProviderSpec } from './piai-engine.js';

export type { ThinkingLevel, ThinkingLevelMap } from './compat.js';

/**
 * Data-driven model catalog (pi-style): providers are data, wire protocols
 * are adapters. User providers/models are declared in `~/.nova/models.json`
 * and merged over the built-in defaults. Ticket (pi-ai-migration) 01: the
 * built-in model lists now come from the pi-ai engine Models collection,
 * so ids/context/cost are no longer hand-written.
 */

/** Built-in provider → default wire API. */
/** Built-in provider defaults — ONE table (ticket 21). */
export const BUILTIN_PROVIDERS: Record<
  string,
  { api: ApiId; baseUrl?: string; contextWindow: number }
> = {
  openai: {
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
  },
  anthropic: {
    api: 'anthropic-messages',
    contextWindow: 200_000,
  },
  ollama: {
    api: 'ollama',
    baseUrl: 'http://localhost:11434',
    contextWindow: 32_768,
  },
};

/** Built-in provider → default wire API (kept for callers/tests). */
export const BUILTIN_PROVIDER_API: Record<string, ApiId> = Object.fromEntries(
  Object.entries(BUILTIN_PROVIDERS).map(([name, entry]) => [name, entry.api]),
);

/** Model pricing, USD per 1M tokens (optional; drives the footer cost). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  /** Pricing for the session-cost estimate (absent = cost hidden). */
  cost?: ModelCost;
  /** Override the provider's wire API for this model. */
  api?: ApiId;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: CompatFlags;
}

/**
 * Per-model patch applied over built-in or declared models
 * (pi-style modelOverrides). Unknown ids are ignored.
 */
export type ModelOverride = Partial<Omit<ModelCatalogEntry, 'id' | 'api'>>;

/** A provider entry as declared in models.json. */
export interface ProviderCatalogEntry {
  /** Optional display name (pi-ai provider display). */
  name?: string;
  baseUrl?: string;
  api?: ApiId;
  apiKey?: string;
  compat?: CompatFlags;
  models?: ModelCatalogEntry[];
  /** Per-model patches over this provider's models (built-ins included). */
  modelOverrides?: Record<string, ModelOverride>;
}

/** The full catalog: built-in defaults merged with user files. */
export interface ModelCatalog {
  providers: Record<string, ProviderCatalogEntry>;
}

/** Fully resolved model info handed to the adapter layer. */
export interface ResolvedModelInfo {
  id: string;
  name: string;
  api: ApiId;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Optional pricing (USD / 1M tokens) for the footer cost segment. */
  cost?: ModelCost;
  thinkingLevelMap?: ThinkingLevelMap;
  compat: NormalizedCompat;
}

/** Result of resolving a model selection. */
export interface ResolvedModel {
  /** Provider name. */
  name: string;
  /** Wire API to use. */
  api: ApiId;
  /** Effective base URL (undefined = adapter/SDK default). */
  baseUrl?: string;
  /** Effective API key. */
  apiKey?: string;
  /** Resolved model metadata. */
  model: ResolvedModelInfo;
}

/** Selection input: config.toml values (already merged with env/CLI). */
export interface ModelSelection {
  provider: string;
  model: string;
  /** Highest-priority overrides (env/CLI/config). */
  baseUrl?: string;
  apiKey?: string;
}

export function defaultContextWindow(provider: string): number {
  return BUILTIN_PROVIDERS[provider]?.contextWindow ?? 128_000;
}

/**
 * Load the model catalog: built-in defaults merged with the given user
 * files (later files win). Merge semantics (pi-style):
 *  - provider-level fields (baseUrl/api/apiKey/compat) override built-ins
 *  - `models` arrays are upserted by id over the built-in list
 * Malformed files are ignored. Ticket 01: built-in provider model lists
 * come from the pi-ai engine's Models collection, and user providers are
 * injected into the same collection.
 */
export function loadModelCatalog(userPaths: string[]): ModelCatalog {
  const engine = new PiaiEngine();
  return loadModelCatalogWithEngine(engine, userPaths).catalog;
}

/**
 * Internal: build the catalog against a shared pi-ai engine. Returns both
 * the catalog (Nova view) and the engine (pi-ai collection) so callers that
 * need the runtime provider set don't recreate it.
 */
export function loadModelCatalogWithEngine(
  engine: PiaiEngine,
  userPaths: string[],
): { catalog: ModelCatalog; engine: PiaiEngine } {
  const catalog: ModelCatalog = { providers: {} };

  // Built-in providers: model lists come from the pi-ai engine so ids and
  // per-model metadata (context, cost, reasoning) are not hand-written.
  for (const [provider, entry] of Object.entries(BUILTIN_PROVIDERS)) {
    const models = engine.describeProviderModels(provider).map((m) => ({
      id: m.id,
      name: m.id,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap as ThinkingLevelMap,
    }));
    catalog.providers[provider] = {
      baseUrl: entry.baseUrl,
      api: entry.api,
      models,
    };
  }

  // User files: inject custom providers into the engine AND merge over the
  // built-in catalog (later files win, pi-style upsert semantics).
  for (const filePath of userPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let parsed: {
      providers?: Record<
        string,
        ProviderCatalogEntry & { name?: string }
      >;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Malformed user file: ignore, built-ins stay usable
    }

    for (const [name, userEntry] of Object.entries(parsed.providers ?? {})) {
      // Register / sync the provider's models into the pi-ai collection.
      if (catalog.providers[name] === undefined) {
        const spec: UserProviderSpec = {
          id: name,
          name: userEntry.name ?? name,
          baseUrl: userEntry.baseUrl,
          api: userEntry.api,
          models: (userEntry.models ?? []).map((m) => ({
            id: m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
            cost: m.cost,
            thinkingLevelMap: m.thinkingLevelMap,
          })),
        };
        engine.registerUserProvider(spec);
      }

      const base = catalog.providers[name] ?? { models: [] };
      const baseModels =
        catalog.providers[name]?.models ??
        engine
          .describeProviderModels(name)
          .map((m) => ({ id: m.id, contextWindow: m.contextWindow }));
      const merged: ProviderCatalogEntry = {
        ...base,
        ...userEntry,
        models: mergeModels(baseModels, userEntry.models ?? []),
      };
      // Apply per-model overrides (pi-style): unknown ids are ignored
      merged.models = applyOverrides(merged.models ?? [], userEntry.modelOverrides ?? {});
      catalog.providers[name] = merged;
    }
  }

  return { catalog, engine };
}

/** Upsert user models by id over the existing list (built-ins kept). */
function mergeModels(base: ModelCatalogEntry[], user: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const entry of user) {
    byId.set(entry.id, { ...byId.get(entry.id), ...entry });
  }
  return [...byId.values()];
}

/** Apply per-model patches; unknown ids ignored; compat merged per key. */
function applyOverrides(models: ModelCatalogEntry[], overrides: Record<string, ModelOverride>): ModelCatalogEntry[] {
  return models.map((model) => {
    const override = overrides[model.id];
    if (!override) return model;
    return {
      ...model,
      ...override,
      compat: { ...model.compat, ...override.compat },
    };
  });
}

/**
 * Parse a /model spec into a selection:
 *  - '' → current provider, current model (listing)
 *  - 'model-id' → current provider
 *  - 'provider/model-id' → explicit provider
 */
export function parseModelSpec(spec: string, currentProvider: string): { provider: string; model: string } {
  const trimmed = spec.trim();
  if (trimmed.includes('/')) {
    const idx = trimmed.indexOf('/');
    return { provider: trimmed.slice(0, idx).trim(), model: trimmed.slice(idx + 1).trim() };
  }
  return { provider: currentProvider, model: trimmed };
}

/**
 * Human-readable model listing for a provider (for the /model command).
 * Marks the current model.
 */
export function describeModels(
  catalog: ModelCatalog,
  provider: string,
  currentModel: string,
): string {
  const entry = catalog.providers[provider];
  if (!entry) {
    return `Unknown provider: ${provider}`;
  }

  const lines: string[] = [`Provider: ${provider}`];
  for (const model of entry.models ?? []) {
    const marker = model.id === currentModel ? ' *' : '  ';
    const parts = [`${marker} ${model.id}`];
    if (model.name && model.name !== model.id) parts.push(`(${model.name})`);
    const ctx = model.contextWindow ?? defaultContextWindow(provider);
    parts.push(`ctx ${ctx.toLocaleString()}`);
    if (model.reasoning) parts.push('[reasoning]');
    lines.push(parts.join('  '));
  }
  lines.push('', 'Switch with: /model <id>  or  /model <provider>/<id>');
  return lines.join('\n');
}
/**
 * Resolve a model selection against the catalog.
 * Explicit overrides (env/CLI/config) win over catalog values.
 */
export function resolveModel(selection: ModelSelection, catalog: ModelCatalog): ResolvedModel {
  const entry = catalog.providers[selection.provider];
  if (!entry) {
    throw new Error(`Unknown provider: ${selection.provider}`);
  }

  const modelEntry = (entry.models ?? []).find((m) => m.id === selection.model);
  const api: ApiId = modelEntry?.api ?? entry.api ?? BUILTIN_PROVIDER_API[selection.provider];
  if (!api) {
    throw new Error(`Unknown provider: ${selection.provider} (no api configured)`);
  }

  const compatFlags: CompatFlags = { ...entry.compat, ...modelEntry?.compat };

  return {
    name: selection.provider,
    api,
    baseUrl: selection.baseUrl ?? entry.baseUrl,
    // Catalog-declared keys go through the value-resolution DSL
    // ("$ENV" interpolation / "!command"); explicit overrides (env/CLI)
    // are used verbatim.
    apiKey: selection.apiKey ?? (entry.apiKey !== undefined
      ? resolveSecretValue(entry.apiKey)
      : undefined),
    model: {
      id: selection.model,
      name: modelEntry?.name ?? selection.model,
      api,
      contextWindow: modelEntry?.contextWindow ?? defaultContextWindow(selection.provider),
      maxTokens: modelEntry?.maxTokens ?? 16_384,
      reasoning: modelEntry?.reasoning ?? false,
      cost: modelEntry?.cost,
      thinkingLevelMap: modelEntry?.thinkingLevelMap,
      compat: normalizeCompat(compatFlags),
    },
  };
}
