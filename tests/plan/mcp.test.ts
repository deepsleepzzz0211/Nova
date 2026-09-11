import { describe, it, expect } from 'vitest';
import { createMCPTool } from '../../src/mcp/tool-bridge.js';

describe('MCP tool bridge', () => {
  it('wraps MCP tool into standard Tool interface', () => {
    const mockClient = { name: 'test-server', config: { autoApprove: false }, callTool: async () => ({ content: 'result' }) } as any;
    const mcpTool = { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };

    const tool = createMCPTool(mockClient, mcpTool);
    expect(tool.name).toBe('mcp_test-server_search');
    expect(tool.description).toBe('Search things');
    expect(tool.parameters).toEqual(mcpTool.inputSchema);
  });

  it('requires permission by default', () => {
    const mockClient = { name: 'srv', config: { autoApprove: false }, callTool: async () => ({}) } as any;
    const tool = createMCPTool(mockClient, { name: 't', description: 'd', inputSchema: {} });
    expect(tool.permission).toEqual({ mode: 'ask', message: 'MCP tool requires confirmation' });
  });

  it('auto-approves when configured', () => {
    const mockClient = { name: 'srv', config: { autoApprove: true }, callTool: async () => ({}) } as any;
    const tool = createMCPTool(mockClient, { name: 't', description: 'd', inputSchema: {} });
    expect(tool.permission).toEqual({ mode: 'auto' });
  });
});
