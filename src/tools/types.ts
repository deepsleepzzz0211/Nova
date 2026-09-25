import type { ToolDefinition } from '../llm/types.js';
import type { Tool } from '../shared/tool-contracts.js';

/**
 * Public tool surface. The cross-module contract types live in
 * `shared/tool-contracts.ts` (audit-fixes ticket 01) and are re-exported
 * here so tool-internal code keeps a single import point.
 */
export type {
  Tool,
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolDisplay,
  ToolPermission,
  ApprovalNarrow,
} from '../shared/tool-contracts.js';

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
