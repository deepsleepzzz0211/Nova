/**
 * Model/catalog wiring (p1-p2 10, split out of index.tsx): the ONE place a
 * provider instance is constructed (ticket 20), plus the live /model
 * selection state and the shared spec resolution used by /model switching
 * and subagent routing.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { novaHome } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import {
  loadModelCatalogWithEngine,
  resolveModel,
  describeModels,
  parseModelSpec,
  type ModelCatalog,
  type ModelCost,
  type ResolvedModel,
} from '../llm/catalog.js';
import { PiaiEngine } from '../llm/piai-engine.js';
import { PiProvider } from '../llm/index.js';
import type { LLMProvider } from '../llm/provider.js';

export interface ModelRuntime {
  catalog: ModelCatalog;
  resolution: ResolvedModel;
  createProvider: (next: ResolvedModel) => LLMProvider;
  listModels: () => string;
  resolveSpec: (spec: string) => ResolveSpecResult;
  resolveSwitch: (spec: string) => SwitchResult;
}

export type ResolveSpecResult =
  | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string; cost?: ModelCost }
  | { ok: false; message: string };

export type SwitchResult =
  | (Extract<ResolveSpecResult, { ok: true }> & { message: string })
  | { ok: false; message: string };

export function buildModelRuntime(config: AppConfig): ModelRuntime {
  // Model catalog: user-level models.json merged over built-in providers.
  // The catalog and the pi-ai engine are built together (ticket 01/03): the
  // engine is the runtime provider set the PiProviders stream through.
  const { catalog, engine } = loadModelCatalogWithEngine(new PiaiEngine(), [
    path.join(novaHome(), '.nova', 'models.json'),
  ]);
  const resolution = resolveModel(
    {
      provider: config.llm.provider || 'openai',
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    },
    catalog,
  );

  // Client identity sent on every provider request (e.g. OpenCode Go
  // requires a stable x-opencode-session per conversation + own UA).
  const defaultHeaders: Record<string, string> = {
    'User-Agent': `nova/${__NOVA_VERSION__}`,
    'x-opencode-session': randomUUID(),
  };

  const createProvider = (next: ResolvedModel): LLMProvider =>
    new PiProvider({
      engine,
      provider: next.name,
      model: next.model.id,
      baseUrl: next.baseUrl,
      apiKey: next.apiKey,
      defaultHeaders,
      maxStreamRetries: config.llm.streamMaxRetries,
      ...(config.llm.cacheRetention !== undefined
        ? { cacheRetention: config.llm.cacheRetention }
        : {}),
    });

  // Live model selection state (mutated by the /model command)
  const selectionRef = {
    provider: config.llm.provider || 'openai',
    model: config.llm.model,
  };

  // /model listing (catalog-driven; loop application in useAgent)
  const listModels = (): string => describeModels(catalog, selectionRef.provider, selectionRef.model);

  const resolveSpec = (spec: string): ResolveSpecResult => {
    try {
      const parsed = parseModelSpec(spec, selectionRef.provider);
      // Config-level base_url/api_key belong to the CONFIGURED provider: only
      // pass them when the spec stays on that provider, otherwise the request
      // would go to the wrong endpoint (e.g. switching to a catalog provider
      // while config.toml still points at opencode-go). Pre-existing bug found
      // while wiring E2E against a second provider.
      const sameProvider = parsed.provider === (config.llm.provider || 'openai');
      const next = resolveModel(
        {
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: sameProvider ? config.llm.baseUrl : undefined,
          apiKey: sameProvider ? config.llm.apiKey : undefined,
        },
        catalog,
      );
      const llmNext = createProvider(next);
      return {
        ok: true,
        llm: llmNext,
        model: next.model.id,
        contextWindow: next.model.contextWindow,
        providerName: next.name,
        cost: next.model.cost,
      };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  const resolveSwitch = (spec: string): SwitchResult => {
    const result = resolveSpec(spec);
    if (result.ok) {
      selectionRef.provider = result.providerName;
      selectionRef.model = result.model;
      return { ...result, message: `Switched to ${result.providerName}/${result.model} (ctx ${result.contextWindow.toLocaleString()})` };
    }
    return result;
  };

  return { catalog, resolution, createProvider, listModels, resolveSpec, resolveSwitch };
}
