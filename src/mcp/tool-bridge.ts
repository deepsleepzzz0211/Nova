import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { JSONSchema } from '../llm/types.js';

/** Minimal client interface needed by the tool bridge and the manager. */
export interface MCPClientLike {
  name: string;
  config: { autoApprove?: boolean };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }>;
  listTools(): Promise<
    { name: string; description?: string; inputSchema: import('../llm/types.js').JSONSchema }[]
  >;
}

/** Shape of an MCP tool returned by listTools(). */
export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * Wrap an MCP server tool into the standard Tool interface.
 *
 * The resulting tool name follows the pattern `mcp_{serverName}_{toolName}`
 * so that tools from different MCP servers never collide.
 */
export function createMCPTool(client: MCPClientLike, mcpTool: MCPToolInfo): Tool {
  return {
    name: `mcp_${client.name}_${mcpTool.name}`,
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,

    async execute(
      params: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> {
      try {
        const result = await client.callTool(mcpTool.name, params);
        return { content: result.content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: message, isError: true };
      }
    },

    // MCP servers decide their own prompting: when the connection is marked
    // autoApprove the bridged tools run without confirmation (ticket 19).
    permission: client.config.autoApprove
      ? { mode: 'auto' as const }
      : { mode: 'ask' as const, message: 'MCP tool requires confirmation' },
  };
}
