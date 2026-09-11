import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import type { SubagentSpawner } from './spawner.js';
import { scanSubagentOutput } from './output-scan.js';

/** Wall-clock budget for a subagent run (mirrors the tool metadata timeout). */
const spawnerToolTimeoutMs = 600_000;

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
        resumeAgentId: { type: 'string', description: 'Resume an earlier subagent by id: task becomes a follow-up on its existing context' },
      },
      required: ['task'],
    },
    metadata: { category: 'agent', cacheable: false, timeout: 600_000 },
    permission: { mode: 'ask', message: 'Subagent delegation requires confirmation' },
    async execute(
      params: Record<string, unknown>,
      context: ToolContext,
      options?: { confirm?: (toolName: string, p: Record<string, unknown>, message?: string) => Promise<boolean> },
    ): Promise<ToolResult> {
      const task = params.task;
      if (typeof task !== 'string' || !task.trim()) {
        return { content: 'Error: task must be a non-empty string.', isError: true };
      }

      const fullTask = typeof params.context === 'string' && params.context.trim()
        ? `${task}\n\nContext: ${params.context}`
        : task;

      // Timeout/cancellation: an internal controller links the tool's
      // abort signal and the tool timeout to the subagent's execution.
      const controller = new AbortController();
      const onAbort = (): void =>
        controller.abort(context.abortSignal?.reason ?? new Error('subagent cancelled'));
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(`subagent timed out after ${spawnerToolTimeoutMs}ms`)),
        spawnerToolTimeoutMs,
      );
      try {
        const result = await spawner.run(fullTask, {
          confirm: options?.confirm,
          model: typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined,
          resumeAgentId: typeof params.resumeAgentId === 'string' && params.resumeAgentId.trim() ? params.resumeAgentId.trim() : undefined,
          signal: controller.signal,
        });
        // Scan before the report enters the parent context (ticket 06)
        return { content: scanSubagentOutput(result.summary), metadata: { rounds: result.rounds, agentId: result.agentId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Concurrency-limit errors pass through verbatim (they carry the
        // retry hint for the parent); everything else is prefixed.
        return { content: message, isError: true };
      } finally {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
