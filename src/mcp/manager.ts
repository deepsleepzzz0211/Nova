import type { MCPServerConfig } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import { MCPClient } from './client.js';
import { createMCPTool } from './tool-bridge.js';
import type { MCPClientLike, MCPToolInfo } from './tool-bridge.js';

/**
 * Manages the lifecycle of all configured MCP server connections
 * and registers their tools into the application's ToolRegistry.
 */
export class MCPManager {
  private clients: MCPClientLike[] = [];

  constructor(private readonly clientFactory: (config: MCPServerConfig) => MCPClientLike = (config) => new MCPClient(config)) {}

  /** Connect to every configured MCP server. */
  async startAll(configs: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map(async (config) => {
        const client = this.clientFactory(config);
        await client.connect();
        this.clients.push(client);
      }),
    );

    // Log failures but don't block startup for other servers.
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[MCPManager] Failed to start server:', r.reason);
      }
    }
  }

  /** Disconnect all active clients. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      this.clients.map((c) => c.disconnect()),
    );
    this.clients = [];
  }

  /**
   * For every connected client, enumerate its tools and register
   * them into the given ToolRegistry using the standard Tool interface.
   */
  async registerTools(registry: ToolRegistry): Promise<void> {
    for (const client of this.clients) {
      try {
        const tools = await client.listTools();
        for (const mcpTool of tools) {
          const tool = createMCPTool(client, {
            ...mcpTool,
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema as MCPToolInfo['inputSchema'],
          });
          registry.register(tool);
        }
      } catch (error) {
        console.error(
          `[MCPManager] Failed to list tools from "${client.name}":`,
          error,
        );
      }
    }
  }
}
