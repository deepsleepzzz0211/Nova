import type { ThinkingLevelMap } from './types.js';

/**
 * The catalog DATA model (arch2 ticket B2): the shape of `~/.nova/models.json`
 * and the built-in provider table, as a pure type vocabulary. Split out of
 * catalog.ts so the executable module (resolution + IO + engine wiring) keeps
 * a small interface; a change to the on-disk model shape lands here, in one
 * cohesive place, and never touches the resolver's surface.
 */

/** Wire-protocol identifiers (pi-style: API adapters are decoupled from vendors). */
export type ApiId = 'openai-completions' | 'anthropic-messages' | 'ollama';

/**
 * Compatibility flags for third-party endpoints that imitate a wire protocol
 * but deviate in details. Parsed from models.json and carried on the resolved
 * model; the pi-ai engine owns the actual wire behavior.
 */
export interface CompatFlags {
  supportsDeveloperRole?: boolean;
  streamUsage?: boolean;
  /** Deprecated alias of streamUsage. */
  promptCache?: boolean;
}

/** Model pricing, USD per 1M tokens (optional; drives the footer cost). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Normalized compat flags with defaults applied. */
export interface NormalizedCompat {
  supportsDeveloperRole: boolean;
  streamUsage: boolean;
}

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  /** Pricing for the session-cost estimate (absent = cost hidden). */
  cost?: ModelCost;
  /**
   * Wire-API record for the Nova view (resolution + /model display).
   * The actual protocol on the wire is bound per PROVIDER (pi-ai attaches
   * one adapter implementation per provider); a model whose api differs
   * from its provider's is displayed as overridden but still streams on
   * the provider's adapter. Full per-model routing would need pi-ai's
   * api-map providers — separate ticket if it ever bites.
   */
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
