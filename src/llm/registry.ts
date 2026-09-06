import type { LLMProvider, ProviderConfig } from './provider.js';
import type { ApiId } from './compat.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OllamaProvider } from './providers/ollama.js';

/** LLM provider registry. */
export class LLMProviderRegistry {
  private providers = new Map<string, new (config: ProviderConfig) => LLMProvider>();
  private instances = new Map<string, LLMProvider>();

  constructor() {
    // Register built-in providers
    this.register('openai', OpenAIProvider);
    this.register('anthropic', AnthropicProvider);
    this.register('ollama', OllamaProvider);
  }

  /** Register a new provider type. */
  register(name: string, providerClass: new (config: ProviderConfig) => LLMProvider): void {
    this.providers.set(name, providerClass);
  }

  /** Create or get a provider instance. */
  getProvider(config: ProviderConfig): LLMProvider {
    const key = `${config.name}:${config.baseUrl || 'default'}`;
    
    if (!this.instances.has(key)) {
      const ProviderClass = this.providers.get(config.name);
      if (!ProviderClass) {
        throw new Error(`Unknown LLM provider: ${config.name}`);
      }
      this.instances.set(key, new ProviderClass(config));
    }
    
    return this.instances.get(key)!;
  }

  /** Get all available provider names. */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Check if a provider is registered. */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Create or get a provider instance by wire-protocol id (pi-style api layer). */
  getForApi(api: ApiId, config: ProviderConfig): LLMProvider {
    const apiClassMap: Record<ApiId, new (config: ProviderConfig) => LLMProvider> = {
      'openai-completions': OpenAIProvider,
      'anthropic-messages': AnthropicProvider,
      ollama: OllamaProvider,
    };

    const ProviderClass = apiClassMap[api];
    if (!ProviderClass) {
      throw new Error(`Unknown API: ${api}`);
    }

    const key = `api:${api}:${config.baseUrl || 'default'}`;
    if (!this.instances.has(key)) {
      this.instances.set(key, new ProviderClass(config));
    }
    return this.instances.get(key)!;
  }
}

/** Global provider registry. */
export const providerRegistry = new LLMProviderRegistry();