import type { JSONSchema, ToolDefinition } from '../llm/types.js';

/** Context provided to tool execution. */
export interface ToolContext {
  workingDirectory: string;
  abortSignal: AbortSignal;
}

/** Optional execution metadata consumed by the tool execution pipeline. */
export interface ToolMetadata {
  /** Tool category, e.g. 'file' | 'shell' | 'web' | 'mcp'. */
  category: string;
  /** Whether successful results may be served from cache. */
  cacheable: boolean;
  /** Execution timeout in milliseconds. */
  timeout: number;
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
  /** Optional pipeline metadata; defaults to non-cacheable with a default timeout. */
  metadata?: ToolMetadata;
  execute(
    params: Record<string, unknown>,
    context: ToolContext,
    options?: { confirm?: (toolName: string, p: Record<string, unknown>, message?: string) => Promise<boolean> },
  ): Promise<ToolResult>;
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
