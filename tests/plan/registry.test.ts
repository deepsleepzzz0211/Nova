import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/types.js';

function makeTool(name: string): Tool {
  return { name, description: `Tool ${name}`, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: 'ok' }) };
}

describe('ToolRegistry', () => {
  it('registers and retrieves by name', () => {
    const r = new ToolRegistry();
    const t = makeTool('test');
    r.register(t);
    expect(r.get('test')).toBe(t);
    expect(r.get('nope')).toBeUndefined();
  });

  it('returns all tools', () => {
    const r = new ToolRegistry();
    r.register(makeTool('a'));
    r.register(makeTool('b'));
    expect(r.getAll()).toHaveLength(2);
  });

  it('converts to ToolDefinition[]', () => {
    const r = new ToolRegistry();
    r.register(makeTool('my_tool'));
    const defs = r.toToolDefinitions();
    expect(defs[0]).toEqual({ type: 'function', function: { name: 'my_tool', description: 'Tool my_tool', parameters: { type: 'object', properties: {} } } });
  });

  it('overwrites duplicate names', () => {
    const r = new ToolRegistry();
    r.register(makeTool('dup'));
    r.register(makeTool('dup'));
    expect(r.getAll()).toHaveLength(1);
  });
});
