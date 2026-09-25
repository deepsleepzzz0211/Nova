import type { JSONSchema } from '../llm/types.js';

/**
 * Cross-module tool contracts (audit-fixes ticket 01).
 *
 * These types are the shared vocabulary between `tools`, `cache`, `hooks`,
 * and `permission`. They live here so those modules depend only on this leaf
 * layer — the three type-only cycles (cache↔tools, hooks↔tools,
 * permission↔tools) existed purely because the definitions sat inside
 * `tools/`. Runtime instances are still wired by the DI root (`index.tsx`).
 */

/** Context provided to tool execution. */
export interface ToolContext {
  workingDirectory: string;
  abortSignal: AbortSignal;
}

/** Optional execution metadata consumed by the tool execution pipeline. */
export interface ToolMetadata {
  /** Tool category, e.g. 'file' | 'shell' | 'web' | 'mcp'. */
  category: string;
  /** Whether successful results may be served from cache. */
  cacheable: boolean;
  /** Execution timeout in milliseconds. */
  timeout: number;
}

/** Result returned from tool execution. */
export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/** How a tool's primary argument should be summarized in the UI. */
export interface ToolDisplay {
  kind: 'command' | 'path';
  /** Line-level diff rendering for file-mutating tools (ticket 06). */
  diff?: 'edit' | 'write';
}

/**
 * Permission requirement declared by the tool itself (tui-refactor ticket 19):
 * the policy decides always-allow/dangerous cases, but which tools need a
 * confirmation is owned here, not hardcoded by name in the policy.
 */
export interface ToolPermission {
  mode: 'ask' | 'auto';
  /** Message shown with the confirmation prompt. */
  message?: string;
}

/**
 * A tool's own contribution to an approval prompt (ticket 08). The shape is
 * deliberately narrow-only: it can add a preview or escalate to a deny, but
 * there is NO field that turns a required confirmation into an auto-approve —
 * widening is unrepresentable at the type level.
 */
export interface ApprovalNarrow {
  /** Extra context surfaced to the user alongside the prompt. */
  previewNote?: string;
  /** Escalate to a hard deny: the tool refuses to run even if it would ask. */
  block?: boolean;
}

/** A tool that can be invoked by the LLM. */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Optional UI display metadata (command/path argument kind). */
  display?: ToolDisplay;
  /** Declared permission requirement (defaults to 'auto'). */
  permission?: ToolPermission;
  /** Optional pipeline metadata; defaults to non-cacheable with a default timeout. */
  metadata?: ToolMetadata;
  /**
   * Optional hook run just before an 'ask' confirmation. May only narrow the
   * decision (preview / escalate to deny); it can never approve on the user's
   * behalf. See {@link ApprovalNarrow}.
   */
  prepareApproval?(
    params: Record<string, unknown>,
    context: ToolContext,
  ): ApprovalNarrow | Promise<ApprovalNarrow>;
  execute(
    params: Record<string, unknown>,
    context: ToolContext,
    options?: { confirm?: (toolName: string, p: Record<string, unknown>, message?: string) => Promise<boolean> },
  ): Promise<ToolResult>;
}
