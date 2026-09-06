import { describe, it, expect, beforeEach } from 'vitest';
import { LLMProviderRegistry } from '../../src/llm/registry.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import { AnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { OllamaProvider } from '../../src/llm/providers/ollama.js';

describe('LLM Provider Registry', () => {
  let registry: LLMProviderRegistry;

  beforeEach(() => {
    registry = new LLMProviderRegistry();
  });

  it('should have built-in providers registered', () => {
    expect(registry.hasProvider('openai')).toBe(true);
    expect(registry.hasProvider('anthropic')).toBe(true);
    expect(registry.hasProvider('ollama')).toBe(true);
  });

  it('should return available providers', () => {
    const providers = registry.getAvailableProviders();
    expect(providers).toContain('openai');
    expect(providers).toContain('anthropic');
    expect(providers).toContain('ollama');
  });

  it('should create OpenAI provider instance', () => {
    const provider = registry.getProvider({
      name: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it('should create Anthropic provider instance', () => {
    const provider = registry.getProvider({
      name: 'anthropic',
      apiKey: 'test-key',
    });
    
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it('should create Ollama provider instance', () => {
    const provider = registry.getProvider({
      name: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
    
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
    expect(provider.capabilities.streaming).toBe(true);
  });

  it('should throw for unknown provider', () => {
    expect(() => {
      registry.getProvider({ name: 'unknown' });
    }).toThrow('Unknown LLM provider: unknown');
  });

  it('should cache provider instances', () => {
    const provider1 = registry.getProvider({
      name: 'openai',
      apiKey: 'test-key',
    });
    
    const provider2 = registry.getProvider({
      name: 'openai',
      apiKey: 'test-key',
    });
    
    expect(provider1).toBe(provider2);
  });

  it('should allow registering custom providers', () => {
    class CustomProvider implements LLMProvider {
      name = 'custom';
      capabilities = {
        streaming: true,
        toolCalling: false,
        vision: false,
        maxContextLength: 4096,
        models: ['custom-model'],
      };
      
      async *chat() {
        yield { type: 'text_delta' as const, content: 'Custom response' };
      }
    }
    
    registry.register('custom', CustomProvider as any);
    
    expect(registry.hasProvider('custom')).toBe(true);
    
    const provider = registry.getProvider({ name: 'custom' });
    expect(provider.name).toBe('custom');
  });
});