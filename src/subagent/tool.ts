import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { SubagentSpawner } from './spawner.js';
import { scanSubagentOutput } from './output-scan.js';

/**
 * spawn_subagent — delegate a focused task to a fresh subagent context.
 *
 * Only the subagent's final summary returns to the parent context, keeping
 * the parent's window small (mainstream "Task tool" pattern).
 */
export function createSpawnSubagentTool(spawner: SubagentSpawner): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Delegate a focused task to a subagent with its own independent context. ' +
      'Provide a self-contained task description; only the subagent\'s final summary ' +
      'is returned. Use for parallel or context-heavy work (e.g. reading many files).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Self-contained task description for the subagent' },
        context: { type: 'string', description: 'Optional extra context to include in the task' },
        model: { type: 'string', description: 'Optional model spec for this subagent (overrides the configured default)' },
      },
      required: ['task'],
    },
    metadata: { category: 'agent', cacheable: false, timeout: 600_000 },
    requiresPermission: () => true,
    async execute(
      params: Record<string, unknown>,
      _context: ToolContext,
      options?: { confirm?: (toolName: string, p: Record<string, unknown>, message?: string) => Promise<boolean> },
    ): Promise<ToolResult> {
      const task = params.task;
      if (typeof task !== 'string' || !task.trim()) {
        return { content: 'Error: task must be a non-empty string.', isError: true };
      }

      const fullTask = typeof params.context === 'string' && params.context.trim()
        ? `${task}\n\nContext: ${params.context}`
        : task;

      try {
        const result = await spawner.run(fullTask, {
          confirm: options?.confirm,
          model: typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined,
        });
        // Scan before the report enters the parent context (ticket 06)
        return { content: scanSubagentOutput(result.summary), metadata: { rounds: result.rounds } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Concurrency-limit errors pass through verbatim (they carry the
        // retry hint for the parent); everything else is prefixed.
        return { content: message, isError: true };
      }
    },
  };
}
