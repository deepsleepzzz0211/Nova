import type { ToolResult } from '../shared/tool-contracts.js';

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

/**
 * Optional observation from a post hook (batch-B ticket 03): `note` is
 * appended to the tool result content so the model can react to it.
 */
export interface PostToolUseObservation {
  note?: string;
}

/**
 * Runs after tool execution; observation only (cannot alter the result the
 * model sees, except surfacing a note).
 */
export type PostToolUseHook = (
  input: PostToolUseInput,
) => void | PostToolUseObservation | Promise<void | PostToolUseObservation>;

/** Hook bundle installed on the pipeline. */
export interface PipelineHooks {
  pre?: PreToolUseHook[];
  post?: PostToolUseHook[];
}
