import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Tool execution + skill injection helpers for AgentLoop (p1-p2 12, split
 * out of loop.ts). Free functions with explicit deps — the loop keeps all
 * sequencing; these own the per-call mechanics verbatim.
 */

export interface ToolExecDeps {
  toolRegistry: ToolRegistry;
  toolExecutionPipeline: ToolExecutionPipeline;
  abortSignal?: AbortSignal;
  onToolResult: (result: ToolResult, callId?: string) => void;
  onPermissionRequest: (call: ToolCall) => Promise<boolean>;
}

/** Execute one tool call through the pipeline and notify the UI. */
export async function executeToolCall(deps: ToolExecDeps, call: ToolCall): Promise<ToolResult> {
  const { toolRegistry, toolExecutionPipeline, abortSignal, onToolResult, onPermissionRequest } = deps;
  if (abortSignal?.aborted) {
    const result: ToolResult = { content: 'Aborted.', isError: true };
    onToolResult(result, call.id);
    return result;
  }
  const tool = toolRegistry.get(call.function.name);
  if (!tool) {
    const result: ToolResult = {
      content: `Tool "${call.function.name}" not found.`,
      isError: true,
    };
    onToolResult(result, call.id);
    return result;
  }

  try {
    const params = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const result = await toolExecutionPipeline.execute(
      tool,
      params,
      {
        workingDirectory: process.cwd(),
        abortSignal: abortSignal ?? new AbortController().signal,
      },
      { confirm: () => onPermissionRequest(call) },
    );
    onToolResult(result, call.id);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ToolResult = { content: msg, isError: true };
    onToolResult(result, call.id);
    return result;
  }
}

/**
 * Load full bodies of skills matching the user input as an append-only
 * system message. The frozen system prompt itself is never mutated, so
 * the provider prompt-cache prefix stays valid. pushMessage is the loop's
 * own append (history + session log).
 */
export async function injectSkills(
  skills: SkillRegistry | null,
  maxActiveSkills: number,
  userInput: string,
  pushMessage: (message: { role: 'system'; content: string }) => void,
): Promise<void> {
  if (!skills) return;

  const matched = skills.findByKeywords(userInput).slice(0, maxActiveSkills);
  if (matched.length === 0) return;

  const sections: string[] = [];
  for (const meta of matched) {
    try {
      sections.push(await skills.load(meta));
    } catch {
      // Skip skills that cannot be read
    }
  }
  if (sections.length === 0) return;

  pushMessage({
    role: 'system',
    content: `## Active Skills\n${sections.join('\n\n---\n\n')}`,
  });
}
