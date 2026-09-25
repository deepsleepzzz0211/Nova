import {
  createModels,
  createProvider,
  type MutableModels,
  type Provider,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { envApiKeyAuth } from '@earendil-works/pi-ai';

/** Metadata the Nova catalog consumes for one pi-ai model. */
export interface PiaiModelDescriptor {
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
  baseUrl: string;
  api: string;
}

/** One user-declared model in `~/.nova/models.json`. */
export interface UserProviderModelSpec {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
}

/** A user custom provider declared in `~/.nova/models.json`. */
export interface UserProviderSpec {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'anthropic-messages' | 'ollama';
  apiKey?: string;
  models?: UserProviderModelSpec[];
}

/**
 * Wraps a pi-ai `Models` collection — the single source of truth for the
 * provider-and-model universe. Built-in providers come from pi-ai's official
 * factory providers (openai, anthropic); user providers from models.json are
 * injected through `createProvider` so built-ins and user custom providers
 * live in one collection.
 */

/** Built-in openai/anthropic come from pi-ai's official provider catalogs.
 * Ollama has no pi-ai catalog — expose the well-known local defaults so
 * `/model` still lists them before a models.json overrides them. */
const OLLAMA_DEFAULT_MODELS = ['llama3', 'llama2', 'codellama', 'mistral', 'mixtral'];

function ollamaBuiltinModels(): Model<string>[] {
  return OLLAMA_DEFAULT_MODELS.map((id) => ({
    id,
    name: id,
    api: 'openai-completions',
    provider: 'ollama' as const,
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'] as const,
    contextWindow: 32_768,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

/**
 * Nova's protocol choice for the built-in providers — the wire-protocol
 * source of truth. pi-ai's openai factory binds the /responses adapter
 * exclusively, but Nova (and every chat-completions gateway its users
 * point it at) speaks /chat/completions unless told otherwise.
 */
export type ProviderProtocol = 'openai-completions' | 'anthropic-messages' | 'ollama';
export const NOVA_BUILTIN_PROTOCOLS: Record<string, ProviderProtocol> = {
  openai: 'openai-completions',
};

export class PiaiEngine {
  readonly models: MutableModels;

  constructor() {
    this.models = createModels();
    this.registerBuiltins();
    for (const [id, protocol] of Object.entries(NOVA_BUILTIN_PROTOCOLS)) {
      this.enforceProtocol(id, protocol);
    }
  }

  /** Built-in factories pi-ai ships, plus a local OpenAI-compatible ollama. */
  private registerBuiltins(): void {
    this.models.setProvider(openaiProvider());
    this.models.setProvider(anthropicProvider());
    this.models.setProvider(
      createProvider({
        id: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        auth: { apiKey: envApiKeyAuth('Ollama', ['OLLAMA_API_KEY']) },
        models: ollamaBuiltinModels(),
        api: openAICompletionsApi(),
      }),
    );
  }

  /** List registered provider ids. */
  listProviders(): string[] {
    return this.models.getProviders().map((p) => p.id);
  }

  getProvider(id: string) {
    return this.models.getProvider(id);
  }

  getModel(provider: string, id: string) {
    return this.models.getModel(provider, id);
  }

  /**
   * Model metadata for the catalog, sourced from the pi-ai collection.
   */
  describeProviderModels(provider: string): PiaiModelDescriptor[] {
    return this.models.getModels(provider).map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      cost: m.cost,
      baseUrl: m.baseUrl,
      api: m.api,
      thinkingLevelMap: m.thinkingLevelMap
        ? (() => {
            const out: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(m.thinkingLevelMap)) {
              out[k] = v ?? null;
            }
            return out;
          })()
        : undefined,
    }));
  }

  /**
   * Inject a user-declared provider into the same collection via
   * `createProvider`, so on models resolve exactly like built-in ones.
   */
  registerUserProvider(spec: UserProviderSpec): void {    const baseUrl = spec.baseUrl ?? defaultBaseUrl(spec.api, spec.id);
    const api = spec.api ?? 'openai-completions';
    const provider = createProvider({
      id: spec.id,
      name: spec.name ?? spec.id,
      baseUrl,
      auth: { apiKey: envApiKeyAuth(spec.name ?? spec.id, [apiKeyEnvName(spec.id)]) },
      models: (spec.models ?? []).map((m) => ({
        id: m.id,
        name: m.id,
        api,
        provider: spec.id,
        baseUrl,
        reasoning: m.reasoning ?? false,
        input: ['text'] as const,
        contextWindow: m.contextWindow ?? 128_000,
        maxTokens: m.maxTokens ?? 16_384,
        cost:
          m.cost === undefined
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            : {
                input: m.cost.input,
                output: m.cost.output,
                cacheRead: m.cost.cacheRead ?? 0,
                cacheWrite: m.cost.cacheWrite ?? 0,
              },
        thinkingLevelMap: m.thinkingLevelMap,
      })),
      api: pickApi(api),
    });
    this.models.setProvider(provider);
  }

  /**
   * Rebind a registered provider to the protocol Nova's catalog resolves.
   * pi-ai built-in factories hard-bind ONE adapter implementation, so
   * changing model.api is not enough — the provider object is rebuilt with
   * the catalog-chosen adapter over the same model list.
   */
  enforceProtocol(providerId: string, protocol: ProviderProtocol): void {
    const provider = this.models.getProvider(providerId);
    if (!provider) return;
    const models = provider.getModels();
    const modelApi: 'openai-completions' | 'anthropic-messages' =
      protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    if (models.length > 0 && models.every((m) => m.api === modelApi)) {
      return; // pi-ai's model.api mirrors the bound adapter; match = no-op
    }
    this.models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: models[0]?.baseUrl ?? defaultBaseUrl(protocol, providerId),
        auth: { apiKey: envApiKeyAuth(provider.name, [apiKeyEnvName(providerId)]) },
        models: models.map((m) => ({ ...m, api: modelApi })),
        api: pickApi(protocol),
      }),
    );
  }
}

function defaultBaseUrl(api: string | undefined, providerId: string): string {
  if (providerId === 'ollama') return 'http://localhost:11434/v1';
  if (api === 'anthropic-messages') return 'https://api.anthropic.com';
  return 'http://localhost:8000/v1';
}

function apiKeyEnvName(providerId: string): string {
  const upper = providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `${upper}_API_KEY`;
}

function pickApi(api: string) {
  return api === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi();
}

/** Build the default engine: built-in openai/anthropic (+ local ollama). */
export function createPiaiEngine(): PiaiEngine {
  return new PiaiEngine();
}