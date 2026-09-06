import type { LLMProvider, ProviderConfig } from './provider.js';
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
}

/** Global provider registry. */
export const providerRegistry = new LLMProviderRegistry();