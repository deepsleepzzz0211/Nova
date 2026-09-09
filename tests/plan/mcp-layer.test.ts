/**
 * MCP layer first tests (coverage ticket 01). Client behavior is verified
 * against a REAL McpServer paired over InMemoryTransport — no processes.
 * Manager lifecycle uses stub clients injected through the factory seam.
 */
import { describe, it, expect, vi } from 'vitest';
import { MCPClient } from '../../src/mcp/client.js';
import { MCPManager } from '../../src/mcp/manager.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import type { MCPServerConfig } from '../../src/config/schema.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { MCPClientLike } from '../../src/mcp/tool-bridge.js';

const cfg = (name = 'test-server'): MCPServerConfig => ({
  name,
  command: 'noop',
  args: [],
  env: {},
});

/** Server-side tool registrations for the paired fixture. */
function registerTools(server: McpServer): void {
  server.registerTool('echo', {
    description: 'Echo a message',
    inputSchema: { message: z.string() },
  }, async ({ message }) => ({
    content: [{ type: 'text', text: `echo: ${message}` }],
  }));
  server.registerTool('multi', {
    description: 'Multiple text blocks',
    inputSchema: {},
  }, async () => ({
    content: [
      { type: 'text', text: 'block one' },
      { type: 'text', text: 'block two' },
    ],
  }));
}

/** Pair an MCPClient with a real McpServer over an in-memory pipe. */
async function connectPaired(register = registerTools): Promise<MCPClient> {
  const server = new McpServer({ name: 'paired', version: '1.0.0' });
  register(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new MCPClient(cfg(), {
    createTransport: () => clientT,
    createClient: (info) => new Client(info, { capabilities: {} }),
  });
  await client.connect();
  return client;
}

describe('MCPClient (real SDK pairing over InMemoryTransport)', () => {
  it('connects, lists tools, and calls a tool end-to-end', async () => {
    const client = await connectPaired();

    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'multi']);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeDefined();
    }

    const result = await client.callTool('echo', { message: 'hello' });
    expect(result.content).toBe('echo: hello');
  });

  it('concatenates multiple text blocks with newlines', async () => {
    const client = await connectPaired();
    const result = await client.callTool('multi', {});
    expect(result.content).toBe('block one\nblock two');
  });

  it('throws a named error when not connected', async () => {
    const client = new MCPClient(cfg('never-connected'));
    await expect(client.listTools()).rejects.toThrow('MCPClient "never-connected" is not connected');
    await expect(client.callTool('x', {})).rejects.toThrow('MCPClient "never-connected" is not connected');
  });

  it('disconnect clears the connection (tools unavailable afterwards)', async () => {
    const client = await connectPaired();
    await client.disconnect();
    await expect(client.listTools()).rejects.toThrow('not connected');
  });
});

describe('MCPManager lifecycle (stub clients via factory seam)', () => {
  function stubClient(name: string, opts?: { failConnect?: boolean; failList?: boolean }) {
    const calls: string[] = [];
    const client = {
      name,
      config: {},
      connect: async () => {
        if (opts?.failConnect) throw new Error(`connect failed: ${name}`);
        calls.push('connect');
      },
      disconnect: async () => {
        calls.push('disconnect');
      },
      callTool: async () => ({ content: 'stub' }),
      listTools: async () => {
        if (opts?.failList) throw new Error(`list failed: ${name}`);
        return [{ name: 'ping', description: 'Ping tool', inputSchema: { type: 'object', properties: {} } }];
      },
    } as unknown as MCPClientLike;
    return { client, calls };
  }

  it('connects all servers and registers their tools (mcp_ prefix)', async () => {
    const a = stubClient('alpha');
    const b = stubClient('beta');
    const registry = { register: vi.fn() } as unknown as ToolRegistry;
    const manager = new MCPManager((config) => (config.name === 'alpha' ? a.client : b.client));

    await manager.startAll([cfg('alpha'), cfg('beta')]);
    expect(a.calls).toContain('connect');
    expect(b.calls).toContain('connect');

    await manager.registerTools(registry);
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp_alpha_ping' }),
    );
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp_beta_ping' }),
    );
  });

  it('a failing server does not block the others', async () => {
    const good = stubClient('good');
    const bad = stubClient('bad', { failConnect: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new MCPManager((config) => (config.name === 'bad' ? bad.client : good.client));

    await manager.startAll([cfg('bad'), cfg('good')]);
    expect(errSpy).toHaveBeenCalled();
    expect(good.calls).toContain('connect');
    errSpy.mockRestore();
  });

  it('listTools failure logs and continues with other clients', async () => {
    const good = stubClient('good');
    const bad = stubClient('bad', { failList: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = { register: vi.fn() } as unknown as ToolRegistry;
    const manager = new MCPManager((config) => (config.name === 'bad' ? bad.client : good.client));

    await manager.startAll([cfg('bad'), cfg('good')]);
    await manager.registerTools(registry);
    expect(registry.register).toHaveBeenCalledTimes(1); // only the good one
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp_good_ping' }),
    );
    errSpy.mockRestore();
  });

  it('stopAll disconnects every client and clears the pool', async () => {
    const a = stubClient('alpha');
    const b = stubClient('beta');
    const manager = new MCPManager((config) => (config.name === 'alpha' ? a.client : b.client));
    await manager.startAll([cfg('alpha'), cfg('beta')]);
    await manager.stopAll();
    expect(a.calls).toContain('disconnect');
    expect(b.calls).toContain('disconnect');
  });
});
