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

export type { ThinkingLevel, ThinkingLevelMap } from './compat.js';

/**
 * Data-driven model catalog (pi-style): providers are data, wire protocols
 * are adapters. User providers/models are declared in `~/.nova/models.json`
 * and merged over the built-in defaults.
 */

/** Built-in provider → default wire API. */
export const BUILTIN_PROVIDER_API: Record<string, ApiId> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
  ollama: 'ollama',
};

/** Built-in default base URLs (undefined = SDK default). */
const BUILTIN_BASE_URL: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  anthropic: undefined,
  ollama: 'http://localhost:11434',
};

/** Built-in default base URLs per provider (undefined = SDK default). */
const BUILTIN_CONTEXT_WINDOW: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  ollama: 32_768,
};

/** Model pricing, USD per 1M tokens (optional; drives the footer cost). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A model entry as declared in models.json. */
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

function builtinModels(provider: string): ModelCatalogEntry[] {
  switch (provider) {
    case 'openai':
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'].map((id) => ({ id }));
    case 'anthropic':
      return [
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ].map((id) => ({ id }));
    case 'ollama':
      return ['llama3', 'llama2', 'codellama', 'mistral', 'mixtral'].map((id) => ({ id }));
    default:
      return [];
  }
}

function builtinEntry(provider: string): ProviderCatalogEntry {
  return {
    baseUrl: BUILTIN_BASE_URL[provider],
    api: BUILTIN_PROVIDER_API[provider],
    models: builtinModels(provider),
  };
}

export function defaultContextWindow(provider: string): number {
  return BUILTIN_CONTEXT_WINDOW[provider] ?? 128_000;
}

/**
 * Load the model catalog: built-in defaults merged with the given user
 * files (later files win). Merge semantics (pi-style):
 *  - provider-level fields (baseUrl/api/apiKey/compat) override built-ins
 *  - `models` arrays are upserted by id over the built-in list
 * Malformed files are ignored.
 */
export function loadModelCatalog(userPaths: string[]): ModelCatalog {
  const catalog: ModelCatalog = { providers: {} };

  for (const provider of Object.keys(BUILTIN_PROVIDER_API)) {
    catalog.providers[provider] = builtinEntry(provider);
  }

  for (const filePath of userPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let parsed: { providers?: Record<string, ProviderCatalogEntry> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Malformed user file: ignore, built-ins stay usable
    }

    for (const [name, userEntry] of Object.entries(parsed.providers ?? {})) {
      const base = catalog.providers[name] ?? { models: [] };
      const merged: ProviderCatalogEntry = {
        ...base,
        ...userEntry,
        models: mergeModels(base.models ?? [], userEntry.models ?? []),
      };
      // Apply per-model overrides (pi-style): unknown ids are ignored
      merged.models = applyOverrides(merged.models ?? [], userEntry.modelOverrides ?? {});
      catalog.providers[name] = merged;
    }
  }

  return catalog;
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
