import { clampThinkingLevel } from '@earendil-works/pi-ai';
import type {
  AssistantMessageEvent,
  Model,
} from '@earendil-works/pi-ai';
import type { ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import type { LLMProvider, ProviderCapabilities } from '../provider.js';
import type { ChatOptions, Message, StreamChunk } from '../types.js';
import type { ThinkingLevel } from '../compat.js';
import type { PiaiEngine } from '../piai-engine.js';
import { isContextOverflowError } from '../errors.js';
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
  /**
   * Transparent retries when a stream dies inside the safe prelude (before
   * real text or a completed tool batch). Default 1; 0 disables retrying.
   */
  maxStreamRetries?: number;
}

/**
 * Nova thinkingLevel → pi-ai reasoning, clamped to what the resolved model
 * actually supports (pi-ai owns the level map). `off`/undefined and any level
 * a non-reasoning model resolves down to become `undefined` so the parameter
 * is omitted — never sent as an error. xhigh/max pass in place only when the
 * model advertises them; otherwise they degrade to the nearest supported level.
 */
export function resolvePiReasoning(
  model: Model<string>,
  level: ThinkingLevel | undefined,
): ModelsSimpleStreamOptions['reasoning'] {
  if (!level || level === 'off') return undefined;
  const clamped = clampThinkingLevel(model, level);
  return clamped === 'off' ? undefined : clamped;
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
  private readonly maxStreamRetries: number;

  constructor(config: PiProviderConfig) {
    this.engine = config.engine;
    this.provider = config.provider;
    this.defaultModel = config.model;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders;
    this.maxStreamRetries = config.maxStreamRetries ?? 1;
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
    const reasoning = resolvePiReasoning(model, options.thinkingLevel);
    const streamOptions: ModelsSimpleStreamOptions = {
      signal: controller.signal,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
      ...(this.defaultHeaders !== undefined ? { headers: this.defaultHeaders } : {}),
    };

    // Stream-retry-boundary (zcode-borrow 03): translated chunks before the
    // commit point (non-empty text delta, completed tool batch, or terminal
    // status) are held back; a stream failure inside that prelude discards
    // them and re-issues the request. After the boundary, old error-chunk
    // semantics stand. Aborts never retry.
    const maxAttempts = 1 + this.maxStreamRetries;
    let drained = false;
    try {
      for (let attempt = 1; ; attempt++) {
        const translate = createPiaiChunkTranslator();
        const pending: StreamChunk[] = [];
        let committed = false;
        let failure: { event: AssistantMessageEvent } | { thrown: Error } | null = null;

        try {
          const events = this.engine.models.streamSimple(model, context, streamOptions);
          for await (const event of events) {
            if (event.type === 'error') {
              failure = { event };
              break;
            }
            for (const chunk of translate(event)) {
              if (committed) {
                yield chunk;
                continue;
              }
              if (commitsStreamBoundary(chunk)) {
                committed = true;
                yield* flush(pending);
                yield chunk;
              } else if (chunk.type === 'tool_call_start' || chunk.type === 'tool_call_delta') {
                // State-dangerous fragments: a retry would regenerate the
                // whole batch, so hold them back until the boundary lands.
                pending.push(chunk);
              } else {
                // Display-only deltas (thinking, empty text) stream live:
                // they cost a duplicated UI echo on retry but keep the
                // stall watchdog seeing bytes, exactly like the old adapters.
                yield chunk;
              }
            }
          }
        } catch (err: unknown) {
          failure = { thrown: err instanceof Error ? err : new Error(String(err)) };
        }

        if (failure === null) {
          yield* flush(pending); // clean end: deliver anything held back
          drained = true;
          return;
        }

        const aborted =
          'event' in failure && failure.event.type === 'error' && failure.event.reason === 'aborted';
        // Context overflow is deterministic (same oversized payload), not a
        // stall: retrying just wastes a request. The loop's reactive
        // compaction handles it after the error chunk surfaces.
        const failureMessage =
          'event' in failure && failure.event.type === 'error'
            ? failure.event.error.errorMessage ?? ''
            : 'thrown' in failure
              ? failure.thrown.message
              : '';
        const overflow = isContextOverflowError(failureMessage);
        if (
          !committed &&
          !aborted &&
          !overflow &&
          attempt < maxAttempts &&
          !controller.signal.aborted
        ) {
          continue; // transparent retry
        }

        // Adapter-equivalent failure surface: the loop reports error chunks
        // and short-circuits tool execution. Held-back fragments are
        // discarded — the loop would drop the tool batch on error anyway.
        pending.length = 0;
        if ('event' in failure) {
          yield* translate(failure.event);
        } else {
          yield { type: 'error', error: failure.thrown.message };
        }
        drained = true;
        return;
      }
    } finally {
      if (!drained) controller.abort();
    }
  }
}

/** True when this chunk makes the stream un-retryable (real content landed). */
function commitsStreamBoundary(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text_delta':
      return chunk.content !== '';
    case 'tool_call_end':
    case 'truncated':
    case 'usage':
      return true;
    default:
      return false;
  }
}

function flush(pending: StreamChunk[]): StreamChunk[] {
  const out = pending.slice();
  pending.length = 0;
  return out;
}
