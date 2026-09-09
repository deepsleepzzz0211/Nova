import type { StreamChunk } from './types.js';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.js';

/**
 * Parse an OpenAI streaming response into our normalized StreamChunk format.
 *
 * Handles:
 * - Text deltas from chunk.choices[0].delta.content
 * - Tool call tracking by index (multiple simultaneous tool calls)
 * - tool_call_start: when chunk has tc.id and tc.function.name
 * - tool_call_delta: accumulates argument fragments per index
 * - tool_call_end: when finish_reason is 'tool_calls' or 'stop'
 * - Safety flush for remaining tool_calls at stream end
 */
export async function* parseOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<StreamChunk> {
  // Track in-progress tool calls by their index
  const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    // Usage arrives on a final chunk with empty choices (include_usage)
    if (chunk.usage) {
      yield {
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    const { delta, finish_reason } = choice;

    // Emit thinking deltas (reasoning models: DeepSeek/OpenRouter style)
    if ((delta as { reasoning_content?: string }).reasoning_content) {
      yield { type: 'thinking_delta', content: (delta as { reasoning_content: string }).reasoning_content };
    }

    // Emit text deltas
    if (delta.content) {
      yield { type: 'text_delta', content: delta.content };
    }

    // Process tool call fragments
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const { index } = tc;

        if (tc.id && tc.function?.name) {
          // New tool call starting
          pendingToolCalls.set(index, {
            id: tc.id,
            name: tc.function.name,
            arguments: '',
          });
          yield { type: 'tool_call_start', id: tc.id, name: tc.function.name };
        }

        // Accumulate argument fragments
        if (tc.function?.arguments) {
          const pending = pendingToolCalls.get(index);
          if (pending) {
            pending.arguments += tc.function.arguments;
            yield { type: 'tool_call_delta', id: pending.id, arguments: tc.function.arguments };
          }
        }
      }
    }

    // End tool calls on finish_reason
    if (finish_reason === 'tool_calls' || finish_reason === 'stop') {
      // Flush all pending tool calls
      for (const [, tc] of pendingToolCalls) {
        yield { type: 'tool_call_end', id: tc.id };
      }
      pendingToolCalls.clear();
    }
  }

  // Safety flush: if the stream ended without a proper finish_reason,
  // flush any remaining pending tool calls
  if (pendingToolCalls.size > 0) {
    for (const [, tc] of pendingToolCalls) {
      yield { type: 'tool_call_end', id: tc.id };
    }
    pendingToolCalls.clear();
  }
}
