import { Type } from '@earendil-works/pi-ai';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message as PiaiMessage,
  TextContent,
  Tool,
  ToolCall as PiaiToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { Message, StreamChunk, ToolDefinition } from './types.js';
import { withSystemPrompt } from './messages.js';

/**
 * Pure conversion bridge between Nova's LLM vocabulary and pi-ai's
 * (messages / tools / streaming events). No network, no provider state —
 * this is the kernel the PiProvider builds on.
 */

/** Input shape accepted by {@link toPiaiContext}. */
export interface PiaiContextInput {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

/** Zeroed pi-ai usage record for replayed (non-living) messages. */
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Metadata fields pi-ai requires on every replayed assistant message. */
function assistantEnvelope() {
  return {
    api: '' as string,
    provider: '' as string,
    model: '' as string,
    usage: emptyUsage(),
  };
}

function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

function parseToolArguments(toolName: string, raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid arguments JSON in tool call "${toolName}": ${detail}`);
  }
}

/** Convert Nova tool definitions to pi-ai tools (TypeBox-wrapped JSON Schema). */
export function toPiaiTools(tools: ToolDefinition[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.function.parameters),
  }));
}

/** Convert Nova history messages to pi-ai messages (system messages excluded). */
export function toPiaiMessages(messages: Message[]): PiaiMessage[] {
  const toolCallNames = new Map<string, string>();
  const out: PiaiMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.content, timestamp: Date.now() });
        break;
      case 'assistant': {
        const content: AssistantMessage['content'] = [];
        if (message.thinking) {
          content.push({ type: 'thinking', thinking: message.thinking });
        }
        if (message.content) {
          content.push(textBlock(message.content));
        }
        for (const call of message.tool_calls ?? []) {
          toolCallNames.set(call.id, call.function.name);
          content.push({
            type: 'toolCall',
            id: call.id,
            name: call.function.name,
            arguments: parseToolArguments(call.function.name, call.function.arguments),
          });
        }
        out.push({
          role: 'assistant',
          content,
          ...assistantEnvelope(),
          stopReason: message.tool_calls?.length ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool':
        out.push({
          role: 'toolResult',
          toolCallId: message.tool_call_id,
          toolName: toolCallNames.get(message.tool_call_id) ?? message.tool_call_id,
          content: [textBlock(message.content)],
          isError: message.is_error ?? false,
          timestamp: Date.now(),
        });
        break;
    }
  }
  return out;
}

/**
 * Build a pi-ai `Context` from Nova request inputs.
 *
 * System-prompt precedence matches `withSystemPrompt`: an option prompt is
 * only prepended when history does not already start with a system message.
 * Mid-history system messages (compaction summaries, injected skills) have no
 * pi-ai role, so they become `[context]`-prefixed user messages, same as the
 * anthropic adapter does today.
 */
export function toPiaiContext(input: PiaiContextInput): Context {
  const full = withSystemPrompt(input.messages, input.systemPrompt);

  let systemPrompt: string | undefined;
  const history: Message[] = [];
  for (const [index, message] of full.entries()) {
    if (message.role !== 'system') {
      history.push(message);
      continue;
    }
    if (index === 0) {
      systemPrompt = message.content;
    } else {
      history.push({ role: 'user', content: `[context] ${message.content}` });
    }
  }

  const tools = input.tools && input.tools.length > 0 ? toPiaiTools(input.tools) : undefined;
  return { systemPrompt, messages: toPiaiMessages(history), tools };
}

/** Per-content-index tool-call bookkeeping while translating events. */
interface ToolCallState {
  id: string;
  name: string;
  started: boolean;
  /** Argument fragments received before the start chunk could be emitted. */
  pendingArguments: string;
}

function toolCallBlockAt(partial: AssistantMessage, index: number): PiaiToolCall | undefined {
  const block = partial.content[index];
  return block && block.type === 'toolCall' ? block : undefined;
}

function newToolCallState(): ToolCallState {
  return { id: '', name: '', started: false, pendingArguments: '' };
}

/**
 * Create a stateful translator: one pi-ai `AssistantMessageEvent` in,
 * zero or more Nova `StreamChunk`s out. Each stream gets its own instance.
 */
export function createPiaiChunkTranslator(): (
  event: AssistantMessageEvent,
) => StreamChunk[] {
  const calls = new Map<number, ToolCallState>();

  const beginCall = (state: ToolCallState): StreamChunk[] => {
    state.started = true;
    const chunks: StreamChunk[] = [{ type: 'tool_call_start', id: state.id, name: state.name }];
    if (state.pendingArguments) {
      chunks.push({ type: 'tool_call_delta', id: state.id, arguments: state.pendingArguments });
      state.pendingArguments = '';
    }
    return chunks;
  };

  return (event) => {
    switch (event.type) {
      case 'text_delta':
        return [{ type: 'text_delta', content: event.delta }];
      case 'thinking_delta':
        return [{ type: 'thinking_delta', content: event.delta }];

      case 'toolcall_start': {
        const block = toolCallBlockAt(event.partial, event.contentIndex);
        const state = newToolCallState();
        state.id = block?.id ?? '';
        state.name = block?.name ?? '';
        calls.set(event.contentIndex, state);
        if (state.id && state.name) return beginCall(state);
        return [];
      }

      case 'toolcall_delta': {
        let state = calls.get(event.contentIndex);
        if (!state) {
          state = newToolCallState();
          calls.set(event.contentIndex, state);
        }
        const block = toolCallBlockAt(event.partial, event.contentIndex);
        if (!state.id) state.id = block?.id ?? '';
        if (!state.name) state.name = block?.name ?? '';
        if (!state.started) {
          if (state.id && state.name) return [...beginCall(state), { type: 'tool_call_delta' as const, id: state.id, arguments: event.delta }];
          // No id yet — a Nova delta must carry one, so hold the fragment.
          state.pendingArguments += event.delta;
          return [];
        }
        return [{ type: 'tool_call_delta', id: state.id, arguments: event.delta }];
      }

      case 'toolcall_end': {
        const state = calls.get(event.contentIndex);
        if (!state) {
          // Provider ended a call without ever emitting toolcall_start;
          // reconstruct the lifecycle so argument accumulators still work.
          return [
            { type: 'tool_call_start', id: event.toolCall.id, name: event.toolCall.name },
            {
              type: 'tool_call_delta',
              id: event.toolCall.id,
              arguments: JSON.stringify(event.toolCall.arguments),
            },
            { type: 'tool_call_end', id: event.toolCall.id },
          ];
        }
        if (!state.id) state.id = event.toolCall.id;
        if (!state.name) state.name = event.toolCall.name;
        const chunks = state.started ? [] : beginCall(state);
        chunks.push({ type: 'tool_call_end', id: state.id });
        return chunks;
      }

      case 'done': {
        const usage = event.message.usage;
        const chunks: StreamChunk[] = [
          {
            type: 'usage',
            // Nova's inputTokens is the full prompt size, cache included.
            inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
            outputTokens: usage.output,
            cachedInputTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
          },
        ];
        if (event.reason === 'length') chunks.push({ type: 'truncated' });
        return chunks;
      }

      case 'error': {
        // Both terminal reasons surface as an error chunk, matching the
        // wire adapters (their catch-all yields an error on abort too).
        // sawError short-circuits tool execution in the agent loop, which
        // is what keeps a half-streamed tool call from being executed.
        const fallback = event.reason === 'aborted' ? 'aborted' : 'pi-ai stream error';
        return [{ type: 'error', error: event.error.errorMessage ?? fallback }];
      }

      case 'start':
      case 'text_start':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_end':
        return [];
    }
  };
}

/** Adapt a pi-ai event stream into a Nova StreamChunk stream. */
export async function* toNovaChunks(
  events: AsyncIterable<AssistantMessageEvent>,
): AsyncGenerator<StreamChunk> {
  const translate = createPiaiChunkTranslator();
  for await (const event of events) {
    yield* translate(event);
  }
}
