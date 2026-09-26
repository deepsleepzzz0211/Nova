import type { StreamChunk, ToolCall } from '../llm/types.js';
import type { TurnUsage } from '../cache/prompt-cache-metrics.js';

/**
 * Per-round stream reduction for AgentLoop.runTurn (p1-p2 12, split out of
 * loop.ts): accumulates text/thinking deltas, assembles fragmented tool
 * calls, tracks the truncated/error flags and sums usage. Pure state — the
 * loop keeps all decisions (what to push, when to continue/return).
 */

/** Aggregated usage for one turn, matching the loop's accumulator shape. */
export type TurnUsageAgg = Required<Pick<TurnUsage, 'inputTokens' | 'outputTokens'>> & Partial<TurnUsage>;

export interface RoundCbs {
  onToken: (token: string) => void;
  /** Always provided by the caller (a wrapper that may no-op); the
   *  optionality of thinking lives in AgentLoop, not the accumulator. */
  onThinking: (delta: string) => void;
  onToolCall: (call: ToolCall) => void;
}

export class RoundAccumulator {
  readonly toolCalls = new Map<string, { name: string; args: string }>();
  textContent = '';
  thinkingContent = '';
  sawTruncated = false;
  sawError = false;

  /**
   * `usage` is the TURN-level aggregator owned by runTurn (declared once
   * before the round loop): providers report usage per round and the loop
   * emits the accumulated total, exactly as before the split.
   */
  constructor(
    private readonly cbs: RoundCbs,
    readonly usage: TurnUsageAgg,
  ) {}

  /** Fold one stream chunk into the round state (verbatim from runTurn). */
  handleChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text_delta':
        this.textContent += chunk.content;
        this.cbs.onToken(chunk.content);
        break;
      case 'thinking_delta':
        this.thinkingContent += chunk.content;
        this.cbs.onThinking(chunk.content);
        break;
      case 'truncated':
        this.sawTruncated = true;
        break;
      case 'tool_call_start':
        this.toolCalls.set(chunk.id, { name: chunk.name, args: '' });
        // Surface the call immediately (streaming ticket 04): the UI
        // shows it as pending while arguments still stream in.
        this.cbs.onToolCall({
          id: chunk.id,
          type: 'function',
          function: { name: chunk.name, arguments: '' },
        });
        break;
      case 'tool_call_delta': {
        const tc = this.toolCalls.get(chunk.id);
        if (tc) tc.args += chunk.arguments;
        break;
      }
      case 'tool_call_end': {
        // no-op; tool call is complete in the map
        break;
      }
      case 'error':
        this.sawError = true;
        this.cbs.onToken(`[Error: ${chunk.error}]`);
        break;
      case 'usage':
        this.usage.inputTokens += chunk.inputTokens;
        this.usage.outputTokens += chunk.outputTokens;
        this.usage.cachedInputTokens = (this.usage.cachedInputTokens ?? 0) + (chunk.cachedInputTokens ?? 0);
        this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (chunk.cacheWriteTokens ?? 0);
        break;
    }
  }
}
