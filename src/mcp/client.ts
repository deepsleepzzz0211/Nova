import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../config/schema.js';
import type { JSONSchema } from '../llm/types.js';

/** Summary of a tool reported by an MCP server. */
export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * Wraps the official MCP SDK Client to provide a simplified interface
 * for spawning a server process, listing tools, and calling tools.
 */
export class MCPClient {
  readonly name: string;
  readonly config: MCPServerConfig;

  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.name = config.name;
  }

  /** Spawn the server process and perform the MCP handshake. */
  async connect(): Promise<void> {
    const serverParams: StdioServerParameters = {
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      stderr: 'pipe',
    };

    this.transport = new StdioClientTransport(serverParams);

    this.client = new Client(
      { name: `nova-${this.name}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
  }

  /** Return the list of tools exposed by the server. */
  async listTools(): Promise<MCPToolInfo[]> {
    if (!this.client) {
      throw new Error(`MCPClient "${this.name}" is not connected`);
    }

    const response = await this.client.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as JSONSchema,
    }));
  }

  /** Invoke a tool on the server and return the text content. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string }> {
    if (!this.client) {
      throw new Error(`MCPClient "${this.name}" is not connected`);
    }

    const result = await this.client.callTool({ name, arguments: args });

    // The SDK returns an array of content blocks. Concatenate text blocks.
    const contentArray = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (Array.isArray(contentArray)) {
      const text = contentArray
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return { content: text };
    }

    // Fallback for legacy / compatibility format
    const legacy = (result as { toolResult?: unknown }).toolResult;
    if (legacy !== undefined) {
      return { content: String(legacy) };
    }

    return { content: '' };
  }

  /** Shut down the connection and the server process. */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    this.client = undefined;
  }
}
