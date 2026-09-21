import type { ToolContext, ToolResult, ApprovalNarrow } from './types.js';
import type { Tool } from './types.js';
import type { ToolResultCache } from '../cache/tool-result-cache.js';
import type { PermissionPolicy } from '../permission/policy.js';
import type { PipelineHooks } from '../hooks/types.js';

/**
 * Result of a confirmation prompt. A bare boolean keeps the legacy contract
 * (no argument edit); the object form lets an approval UI return REVISED
 * params, which the pipeline then re-checks against the permission policy.
 */
export type ApprovalOutcome =
  | { approved: boolean }
  | { approved: boolean; params: Record<string, unknown> };

/** Callback that asks the user to confirm an 'ask' permission decision. */
export type ConfirmCallback = (
  toolName: string,
  params: Record<string, unknown>,
  message?: string,
) => Promise<boolean | ApprovalOutcome>;

/** Bound the approve→edit→re-ask loop so a tool can't ping-pong forever. */
const MAX_APPROVAL_ROUNDS = 4;

function normalizeApproval(result: boolean | ApprovalOutcome): {
  approved: boolean;
  params?: Record<string, unknown>;
} {
  if (typeof result === 'boolean') return { approved: result };
  return 'params' in result
    ? { approved: result.approved, params: result.params }
    : { approved: result.approved };
}

/** Reduce a confirm result to a plain yes/no (for boolean-only consumers). */
export function approvalAllowed(result: boolean | ApprovalOutcome): boolean {
  return normalizeApproval(result).approved;
}

function joinMessages(base: string | undefined, note: string | undefined): string | undefined {
  const parts = [base, note].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Options for a single pipeline execution. */
export interface ExecuteOptions {
  /** User confirmation callback for 'ask' decisions. When absent, ask → deny. */
  confirm?: ConfirmCallback;
}

/** Default timeout for tools without metadata.timeout (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default max characters of tool output admitted into context. */
const DEFAULT_MAX_RESULT_CHARS = 20_000;

/** Options for constructing the pipeline. */
export interface PipelineOptions {
  /** Max characters of tool output admitted into context. Default 20_000. */
  maxResultChars?: number;
  /** Pre/Post tool-use hooks. */
  hooks?: PipelineHooks;
}

/**
 * The single execution path for every tool invocation.
 *
 * Order of checks (permission always precedes cache):
 *  1. PermissionPolicy decision → deny → error result
 *  2. decision ask → approval loop (bounded):
 *       a. tool.prepareApproval — may add a preview or escalate to deny,
 *          never auto-approve (narrow-only by construction)
 *       b. user confirm (may EDIT the arguments)
 *       c. if edited, re-run the policy on the new input and loop; editing
 *          can only make the gate stricter
 *  3. pre-tool-use hooks (may deny)
 *  4. cache lookup for cacheable tools
 *  5. execute with timeout
 *  6. truncate oversized output; cache successful results
 *  7. post-tool-use hooks (observation only)
 */
export class ToolExecutionPipeline {
  private readonly cache: ToolResultCache;
  private readonly permissionChecker: PermissionPolicy;
  private readonly maxResultChars: number;
  private readonly hooks: PipelineHooks;

  constructor(cache: ToolResultCache, permissionChecker: PermissionPolicy, options?: PipelineOptions) {
    this.cache = cache;
    this.permissionChecker = permissionChecker;
    this.maxResultChars = options?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    this.hooks = options?.hooks ?? {};
  }

  async execute(
    tool: Tool,
    params: Record<string, unknown>,
    context: ToolContext,
    options?: ExecuteOptions,
  ): Promise<ToolResult> {
    // 1. Policy decision
    const permission = this.permissionChecker.check(tool.name, params, tool);

    if (permission.decision === 'deny') {
      return {
        content: `Permission denied for tool "${tool.name}".`,
        isError: true,
      };
    }

    // 2. Approval. 'ask' decisions enter a bounded loop that lets the tool
    // narrow the prompt (preview / escalate to deny — never auto-approve), the
    // user confirm (optionally EDITING the arguments), and re-checks the policy
    // on any edited arguments. Editing can only make the gate stricter.
    let resolvedParams = params;
    if (permission.decision === 'ask') {
      let decision = permission;
      for (let round = 0; ; round++) {
        if (round >= MAX_APPROVAL_ROUNDS) {
          return { content: `Permission denied for tool "${tool.name}" (approval loop guard).`, isError: true };
        }
        // The tool's own narrowing runs on the CURRENT params every round —
        // including params a re-check just resolved to 'allow' — so an edit
        // can never slip past a block the tool would have raised.
        const narrow: ApprovalNarrow = tool.prepareApproval
          ? await tool.prepareApproval(resolvedParams, context)
          : {};
        if (narrow.block) {
          return {
            content: `Tool "${tool.name}" declined to run (${narrow.previewNote ?? 'blocked by its own approval hook'}).`,
            isError: true,
          };
        }
        if (decision.decision !== 'ask') break; // re-check auto-allowed the edited params
        if (!options?.confirm) {
          // ask with no callback → deny (fail closed, unchanged semantics)
          return { content: `Permission denied for tool "${tool.name}".`, isError: true };
        }
        const promptMessage = joinMessages(decision.message, narrow.previewNote);
        const outcome = normalizeApproval(await options.confirm(tool.name, resolvedParams, promptMessage));
        if (!outcome.approved) {
          return { content: `Permission denied for tool "${tool.name}".`, isError: true };
        }
        if (!outcome.params) break; // approved unchanged → proceed
        // Arguments were edited: re-run the policy on the new input, then loop
        // so prepareApproval re-evaluates and an 'ask' re-prompts.
        resolvedParams = outcome.params;
        decision = this.permissionChecker.check(tool.name, resolvedParams, tool);
        if (decision.decision === 'deny') {
          return { content: `Permission denied for tool "${tool.name}" (edited arguments).`, isError: true };
        }
      }
    }

    // 3. Pre-tool-use hooks (may deny)
    for (const hook of this.hooks.pre ?? []) {
      try {
        const decision = await hook({ tool: tool.name, params: resolvedParams });
        if (decision?.deny) {
          return {
            content: decision.reason ?? `Tool "${tool.name}" blocked by pre-tool-use hook.`,
            isError: true,
          };
        }
      } catch {
        // A crashing hook must not break execution
      }
    }

    // 4. Cache lookup (cacheable tools only, after permission checks)
    const cacheable = tool.metadata?.cacheable ?? false;
    const cacheKey = ToolExecutionPipeline.generateKey(tool.name, resolvedParams);
    if (cacheable) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // 5-6. Execute with timeout, truncate oversized output, cache successes
    try {
      const timeout = tool.metadata?.timeout ?? DEFAULT_TIMEOUT_MS;
      const result = await this.executeWithTimeout(tool, resolvedParams, context, timeout, options);
      const truncated = this.truncateResult(result);

      if (cacheable && !truncated.isError) {
        await this.cache.set(cacheKey, truncated);
      }

      // 7. Post-tool-use hooks (observation only)
      for (const hook of this.hooks.post ?? []) {
        try {
          await hook({ tool: tool.name, params: resolvedParams, result: truncated });
        } catch {
          // A crashing hook must not change the result
        }
      }

      return truncated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Tool execution failed: ${message}`,
        isError: true,
      };
    }
  }

  /** Truncate oversized tool output with a structurally distinct PARTIAL marker. */
  private truncateResult(result: ToolResult): ToolResult {
    if (result.content.length <= this.maxResultChars) {
      return result;
    }
    const total = result.content.length;
    return {
      ...result,
      content:
        result.content.slice(0, this.maxResultChars) +
        `\n\n[PARTIAL: output truncated — showing first ${this.maxResultChars} of ${total} characters. Request a narrower scope (e.g. offset/limit) to see more.]`,
    };
  }

  /** Generate a cache key from tool name and parameters. */
  generateCacheKey(toolName: string, params: Record<string, unknown>): string {
    return ToolExecutionPipeline.generateKey(toolName, params);
  }

  /** Generate cache key from tool name and parameters. */
  static generateKey(toolName: string, params: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(params)}`;
  }

  private async executeWithTimeout(
    tool: Tool,
    params: Record<string, unknown>,
    context: ToolContext,
    timeout: number,
    options?: ExecuteOptions,
  ): Promise<ToolResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tool "${tool.name}" timed out after ${timeout}ms.`)),
        timeout,
      );
      timer.unref?.();
    });

    // The tool-facing confirm keeps the boolean contract: an approval that
    // edited params is handled by the pipeline loop, not the tool itself.
    const execConfirm = options?.confirm
      ? async (name: string, p: Record<string, unknown>, msg?: string): Promise<boolean> =>
          approvalAllowed(await options.confirm!(name, p, msg))
      : undefined;

    try {
      return await Promise.race([
        tool.execute(params, context, { confirm: execConfirm }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
