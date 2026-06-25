/** A tool call made by the assistant. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** JSON Schema object used for tool parameters. */
export type JSONSchema = Record<string, unknown>;

/** Definition of a tool in the format expected by LLM providers. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** A chat message covering all roles. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string; is_error?: boolean };

/** A chunk from a streaming LLM response. */
export type StreamChunk =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'error'; error: string };

/** Options for a chat completion request. */
export interface ChatOptions {
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}
