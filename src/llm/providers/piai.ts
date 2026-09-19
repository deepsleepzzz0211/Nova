import type { Model } from '@earendil-works/pi-ai';
import type { ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import type { LLMProvider, ProviderCapabilities } from '../provider.js';
import type { ChatOptions, Message, StreamChunk } from '../types.js';
import type { ThinkingLevel } from '../compat.js';
import type { PiaiEngine } from '../piai-engine.js';
import { toPiaiContext, createPiaiChunkTranslator } from '../piai-bridge.js';

/** Construction inputs for {@link PiProvider}; mirrors what the catalog resolves. */
export interface PiProviderConfig {
  /** Shared pi-ai engine (Models collection). */
  engine: PiaiEngine;
  /** Provider id — the same string Nova's catalog uses. */
  provider: string;
  /** Model id used when a chat request does not name one. */
  model?: string;
  /** Nova-side endpoint override (config/CLI); wins over the catalog model's baseUrl. */
  baseUrl?: string;
  /** Nova-side API key override (config/CLI/env); wins over provider auth. */
  apiKey?: string;
  /** Client identity headers sent on every request (session id, UA). */
  defaultHeaders?: Record<string, string>;
}

/** pi-ai only understands levels above "off"; Nova's "off" omits reasoning. */
function toPiReasoning(level: ThinkingLevel | undefined): ModelsSimpleStreamOptions['reasoning'] {
  return level && level !== 'off' ? level : undefined;
}

/**
 * Nova's LLMProvider implemented on the pi-ai engine: requests go through
 * `models.streamSimple` with the ticket-02 bridge converting Context in and
 * the event stream out, so the chunk vocabulary (deltas, tool batches,
 * truncated, error, usage) matches the wire adapters the agent loop already
 * consumes. Watchdog/interrupt/overflow stay in the loop layer, which wraps
 * this stream exactly as it wrapped the old adapters.
 */
export class PiProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  private readonly engine: PiaiEngine;
  private readonly provider: string;
  private readonly defaultModel?: string;
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders?: Record<string, string>;

  constructor(config: PiProviderConfig) {
    this.engine = config.engine;
    this.provider = config.provider;
    this.defaultModel = config.model;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders;
    this.name = config.provider;
    this.capabilities = this.buildCapabilities(config.model);
  }

  private buildCapabilities(modelId?: string): ProviderCapabilities {
    const model = modelId ? this.engine.getModel(this.provider, modelId) : undefined;
    return {
      streaming: true,
      toolCalling: true,
      vision: model?.input.includes('image') ?? false,
      maxContextLength: model?.contextWindow ?? 128_000,
      models: this.engine.describeProviderModels(this.provider).map((m) => m.id),
    };
  }

  /**
   * Resolve the request model. Catalog ids go through unchanged; an id the
   * catalog does not list is still sent verbatim on the wire (old-adapter
   * parity for vLLM/ollama-style servers), riding on a template model from
   * the same provider.
   */
  private resolveModel(modelId: string | undefined): Model<string> | undefined {
    if (!modelId) return undefined;
    const known = this.engine.getModel(this.provider, modelId);
    const template = known ?? this.engine.getProvider(this.provider)?.getModels()[0];
    if (!template) return undefined;
    const override: Partial<Model<string>> = {
      ...(known ? {} : { id: modelId, name: modelId }),
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    };
    return known && !this.baseUrl ? known : { ...template, ...override };
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const modelId = options.model || this.defaultModel;
    const model = this.resolveModel(modelId);
    if (!model) {
      yield { type: 'error', error: `Unknown model: ${this.provider}/${modelId ?? '(none)'}` };
      return;
    }

    const context = toPiaiContext({
      messages,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    });

    // Old SDK adapters aborted the HTTP request when the consumer broke out
    // of the generator (iterator return()). pi-ai streams have no return(),
    // so own the AbortController and abort on early exit only.
    const controller = new AbortController();
    const reasoning = toPiReasoning(options.thinkingLevel);
    const streamOptions: ModelsSimpleStreamOptions = {
      signal: controller.signal,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
      ...(this.defaultHeaders !== undefined ? { headers: this.defaultHeaders } : {}),
    };

    const translate = createPiaiChunkTranslator();
    let drained = false;
    try {
      const events = this.engine.models.streamSimple(model, context, streamOptions);
      for await (const event of events) {
        yield* translate(event);
      }
      drained = true;
    } catch (err: unknown) {
      // Adapter-equivalent failure surface: the loop reports error chunks and
      // short-circuits tool execution.
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: message };
      drained = true;
    } finally {
      if (!drained) controller.abort();
    }
  }
}
