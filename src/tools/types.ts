import type { JSONSchema, ToolDefinition } from '../llm/types.js';

/** Context provided to tool execution. */
export interface ToolContext {
  workingDirectory: string;
  abortSignal: AbortSignal;
}

/** Result returned from tool execution. */
export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/** A tool that can be invoked by the LLM. */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  requiresPermission?(params: Record<string, unknown>): boolean;
}

/** Convert a Tool to the ToolDefinition format used by LLM providers. */
export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
