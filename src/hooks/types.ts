import type { ToolResult } from '../tools/types.js';

/** Input for a PreToolUse hook. */
export interface PreToolUseInput {
  tool: string;
  params: Record<string, unknown>;
}

/** Optional decision returned by a PreToolUse hook. */
export interface PreToolUseDecision {
  deny?: boolean;
  reason?: string;
}

/** Runs before tool execution; may deny the call. */
export type PreToolUseHook = (
  input: PreToolUseInput,
) => PreToolUseDecision | void | Promise<PreToolUseDecision | void>;

/** Input for a PostToolUse hook. */
export interface PostToolUseInput {
  tool: string;
  params: Record<string, unknown>;
  result: ToolResult;
}

/** Runs after tool execution; observation only. */
export type PostToolUseHook = (input: PostToolUseInput) => void | Promise<void>;

/** Hook bundle installed on the pipeline. */
export interface PipelineHooks {
  pre?: PreToolUseHook[];
  post?: PostToolUseHook[];
}
