import type { LLMProvider } from '../llm/provider.js';
import type { Message, ToolCall } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { TurnUsage } from '../cache/prompt-cache-metrics.js';
import type { ThinkingLevel } from '../llm/types.js';
import { isContextOverflowError } from '../llm/errors.js';
import { withIdleTimeout, consumeWithInterrupt, StreamInterruptedError } from '../llm/stream-watchdog.js';
import { RoundAccumulator } from './round-accumulator.js';
import type { ContextOps } from './context-ops.js';
import type { AgentTurnResult } from './loop-types.js';

/**
 * The turn engine of AgentLoop (p1-p2 12, split out of loop.ts): round loop,
 * stream consumption, truncation/empty/overflow recovery and tool-call
 * commit. Logic moved verbatim — `host` is the AgentLoop instance; TurnHost
 * is the structural surface runTurn needs (all members are @internal on the
 * class).
 */

/** Continuation instruction appended after a truncated stream (ticket 05). */
const TRUNCATION_CONTINUE_PROMPT =
  'Your previous response was cut off mid-output. Continue exactly where you stopped — do not repeat any content already emitted.';

export interface TurnHost {
  /** @internal Provider may be swapped mid-session (/model) — read per round. */
  llm: LLMProvider;
  /** @internal */ toolRegistry: ToolRegistry;
  /** @internal */ maxToolRounds: number;
  /** @internal */ model: string;
  /** @internal */ ctxOps: ContextOps;
  /** @internal */ readonly frozenSystemPrompt: string;
  /** @internal */ thinkingLevel?: ThinkingLevel;
  /** @internal */ streamIdleTimeoutMs: number;
  /** @internal */ abortSignal?: AbortSignal;
  /** @internal live conversation for provider requests */ currentMessages: Message[];
  /** @internal */ runAbort: AbortController | null;
  /** @internal */ onToken: (token: string) => void;
  /** @internal */ onToolCall: (call: ToolCall) => void;
  /** @internal */ onToolResult: (result: { content: string; isError?: boolean }, callId?: string) => void;
  /** @internal */ onThinking?: (delta: string) => void;
  /** @internal */ onToolCallReady?: (call: ToolCall) => void;
  /** @internal */ pushMessage(message: Message): void;
  /** @internal */ injectSkills(userInput: string): Promise<void>;
  /** @internal */ executeToolCall(call: ToolCall): Promise<{ content: string; isError?: boolean }>;
  /** @internal */ emitUsage(usage: TurnUsage): void;
  /** @internal */ compactNow(origin: 'manual' | 'overflow'): Promise<{ compacted: boolean }>;
}

/** Run a single user-input turn against the frozen system prompt. */
export async function runTurn(host: TurnHost, input: string): Promise<AgentTurnResult> {
  host.pushMessage({ role: 'user', content: input });

  await host.injectSkills(input);
  const systemPrompt = host.frozenSystemPrompt;
  let rounds = 0;
  let finalText = '';
  const turnUsage: Required<Pick<TurnUsage, 'inputTokens' | 'outputTokens'>> & Partial<TurnUsage> = {
    inputTokens: 0,
    outputTokens: 0,
  };

  const tools = host.toolRegistry.toToolDefinitions();

  // Reactive overflow recovery (context-compaction ticket 04): token estimates can never be
  // exact, so when the provider rejects the request for exceeding the
  // context window we compact once (with the truncate fallback) and retry
  // the same round exactly once. A second overflow surfaces as a normal
  // error — no compaction loop.
  let overflowRetried = false;
  // Streaming ticket 05: one continuation after a truncated stream and one
  // retry after an empty stream, per turn.
  let truncationContinued = false;
  let emptyRetried = false;

  for (let toolRound = 0; toolRound <= host.maxToolRounds; toolRound++) {
    await host.ctxOps.prepareContext();
    rounds++;

    const acc = new RoundAccumulator({
      onToken: host.onToken,
      onThinking: (delta) => host.onThinking?.(delta),
      onToolCall: (call) => host.onToolCall(call),
    }, turnUsage);

    // Abort controller for this round's LLM stream (interruptible).
    const runAbort = new AbortController();
    host.runAbort = runAbort;

    try {
      const rawStream = host.llm.chat(host.currentMessages, {
        model: host.model,
        tools,
        systemPrompt,
        thinkingLevel: host.thinkingLevel,
      });

      // Stall watchdog: a provider/proxy that stops emitting bytes must
      // fail the turn instead of hanging forever (idle measured from the
      // last chunk, so slow thinking before the first token is fine).
      const stream = withIdleTimeout(rawStream, host.streamIdleTimeoutMs, () =>
        new Error(`LLM stream stalled — no data for ${Math.round(host.streamIdleTimeoutMs / 1000)}s`),
      );

      // Interruptible consumption: Esc/abort bails out mid-stream while
      // chunks already received keep flowing through the accumulator.
      await consumeWithInterrupt(stream, runAbort.signal, (chunk) => acc.handleChunk(chunk));
    } catch (err: unknown) {
      // Interruption: keep the partial text as the assistant message and
      // DISCARD incomplete tool-call half-frames (their argument JSON may
      // be truncated — executing them would be a hazard). No tool
      // execution, no orphan results; the turn ends cleanly.
      if (err instanceof StreamInterruptedError) {
        // Calls surfaced mid-stream never execute — mark them in the UI
        // (callback only; no tool results are written to history).
        for (const id of acc.toolCalls.keys()) {
          host.onToolResult({ content: 'Interrupted.', isError: true }, id);
        }
        if (acc.textContent || acc.thinkingContent) {
          host.pushMessage({
            role: 'assistant',
            content: acc.textContent || null,
            ...(acc.thinkingContent ? { thinking: acc.thinkingContent } : {}),
          });
        }
        host.onToken('[interrupted]');
        host.runAbort = null;
        host.emitUsage(turnUsage);
        return { text: acc.textContent, rounds };
      }
      // Reactive overflow recovery (context-compaction ticket 04):
      // compact once and retry the same round.
      host.runAbort = null;
      if (isContextOverflowError(err) && !overflowRetried) {
        const compacted = await host.compactNow('overflow');
        if (compacted.compacted) {
          overflowRetried = true;
          toolRound--; // retry the same round after compaction
          rounds--; // the retry is the same round, not a new one
          continue;
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      host.onToken(`[Error: ${msg}]`);
      host.emitUsage(turnUsage);
      return { text: finalText, rounds };
    }

    host.runAbort = null;

    // Truncation: the provider signaled a max-token cutoff mid-output
    // (streaming ticket 05). With partial output, ask the model to
    // continue exactly once; tool-call half-frames are discarded, never
    // executed. A second truncation keeps whatever partial output exists.
    if (acc.sawTruncated && (acc.textContent || acc.thinkingContent || acc.toolCalls.size > 0)) {
      if (!truncationContinued) {
        truncationContinued = true;
        for (const id of acc.toolCalls.keys()) {
          host.onToolResult({ content: 'Truncated before execution.', isError: true }, id);
        }
        host.pushMessage({
          role: 'assistant',
          content: acc.textContent || null,
          ...(acc.thinkingContent ? { thinking: acc.thinkingContent } : {}),
        });
        host.pushMessage({ role: 'user', content: TRUNCATION_CONTINUE_PROMPT });
        finalText += acc.textContent;
        continue;
      }
      if (acc.textContent || acc.thinkingContent) {
        host.pushMessage({
          role: 'assistant',
          content: acc.textContent || null,
          ...(acc.thinkingContent ? { thinking: acc.thinkingContent } : {}),
        });
      }
      finalText += acc.textContent;
      host.emitUsage(turnUsage);
      return { text: finalText, rounds };
    }

    // Empty stream: the provider finished with zero content — abnormal.
    // Retry the round once, then surface a clean error (ticket 05).
    // An explicit error chunk already reported the failure — keep the
    // legacy report-and-stop semantics, no retry.
    if (acc.sawError) {
      host.emitUsage(turnUsage);
      return { text: finalText, rounds };
    }
    if (!acc.textContent && !acc.thinkingContent && acc.toolCalls.size === 0) {
      if (!emptyRetried) {
        emptyRetried = true;
        continue;
      }
      host.onToken('[Error: LLM returned an empty stream]');
      host.emitUsage(turnUsage);
      return { text: finalText, rounds };
    }

    // If the LLM returned tool calls, process them
    if (acc.toolCalls.size > 0) {
      const callArray: ToolCall[] = [];
      for (const [id, tc] of acc.toolCalls) {
        const call: ToolCall = {
          id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        };
        callArray.push(call);
        host.onToolCallReady?.(call);
      }

      // Append assistant message with tool_calls
      host.pushMessage({
        role: 'assistant',
        content: acc.textContent || null,
        tool_calls: callArray,
      });

      // Execute all tool calls of the round concurrently (mainstream
      // pattern); results are appended to the conversation in call order.
      const settled = await Promise.all(
        callArray.map(async (call) => ({ call, result: await host.executeToolCall(call) })),
      );
      for (const { call, result } of settled) {
        host.pushMessage({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
          is_error: result.isError,
        });
      }

      // Cancelled mid-run: stop without another LLM round
      if (host.abortSignal?.aborted) {
        host.pushMessage({ role: 'assistant', content: '' });
        host.emitUsage(turnUsage);
        return { text: '', rounds };
      }

      // Continue to next round — call LLM again with tool results
      continue;
    }

    // Text-only response — append and done
    host.pushMessage({
      role: 'assistant',
      content: acc.textContent,
      ...(acc.thinkingContent ? { thinking: acc.thinkingContent } : {}),
    });
    finalText += acc.textContent;
    host.emitUsage(turnUsage);
    return { text: finalText, rounds };
  }

  // Exceeded maxToolRounds — append what we have and stop
  host.pushMessage({ role: 'assistant', content: '' });
  host.emitUsage(turnUsage);
  return { text: '', rounds };
}
