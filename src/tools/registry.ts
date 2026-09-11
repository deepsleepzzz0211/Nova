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

  /**
   * UI display kind declared by a tool ('command' | 'path'), or undefined.
   * The registry is the single source of tool-display knowledge — UI modules
   * must not hardcode tool names (AGENTS rule; tui-refactor ticket 14).
   */
  displayKindFor(name: string): 'command' | 'path' | undefined {
    return this.tools.get(name)?.display?.kind;
  }

  /** Return all registered tools. */
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Convert all registered tools to LLM-compatible definitions.
   *
   * Definitions are sorted by name so the request prefix is deterministic
   * across sessions regardless of registration order — required for prompt
   * cache stability.
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.getAll()
      .map(toToolDefinition)
      .sort((a, b) => a.function.name.localeCompare(b.function.name));
  }
}
