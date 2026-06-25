import type { Tool } from './types.js';
import { toToolDefinition } from './types.js';
import type { ToolDefinition } from '../llm/types.js';

/** Central registry for all available tools. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool, overwriting any existing tool with the same name. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Return all registered tools. */
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Convert all registered tools to LLM-compatible definitions. */
  toToolDefinitions(): ToolDefinition[] {
    return this.getAll().map(toToolDefinition);
  }
}
