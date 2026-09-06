import type { ToolContext, ToolResult } from './types.js';
import type { Tool } from './types.js';
import type { ToolResultCache } from '../cache/tool-result-cache.js';
import type { PermissionPolicy } from '../permission/policy.js';
import type { PipelineHooks } from '../hooks/types.js';

/** Callback that asks the user to confirm an 'ask' permission decision. */
export type ConfirmCallback = (
  toolName: string,
  params: Record<string, unknown>,
  message?: string,
) => Promise<boolean>;

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
 *  2. decision ask → user confirmation (or deny when no callback)
 *  3. tool.requiresPermission → treated as ask
 *  4. pre-tool-use hooks (may deny)
 *  5. cache lookup for cacheable tools
 *  6. execute with timeout
 *  7. truncate oversized output; cache successful results
 *  8. post-tool-use hooks (observation only)
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
    const permission = this.permissionChecker.check(tool.name, params);

    if (permission.decision === 'deny') {
      return {
        content: `Permission denied for tool "${tool.name}".`,
        isError: true,
      };
    }

    // 2. ask decision → user confirmation
    let allowed = true;
    if (permission.decision === 'ask') {
      allowed = options?.confirm
        ? await options.confirm(tool.name, params, permission.message)
        : false;
    }

    // 3. tool-level requirement overrides an allow decision
    if (allowed && permission.decision !== 'ask' && tool.requiresPermission?.(params)) {
      allowed = options?.confirm ? await options.confirm(tool.name, params) : false;
    }

    if (!allowed) {
      return {
        content: `Permission denied for tool "${tool.name}".`,
        isError: true,
      };
    }

    // 4. Pre-tool-use hooks (may deny)
    for (const hook of this.hooks.pre ?? []) {
      try {
        const decision = await hook({ tool: tool.name, params });
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

    // 5. Cache lookup (cacheable tools only, after permission checks)
    const cacheable = tool.metadata?.cacheable ?? false;
    if (cacheable) {
      const cacheKey = ToolExecutionPipeline.generateKey(tool.name, params);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // 6-7. Execute with timeout, truncate oversized output, cache successes
    try {
      const timeout = tool.metadata?.timeout ?? DEFAULT_TIMEOUT_MS;
      const result = await this.executeWithTimeout(tool, params, context, timeout, options);
      const truncated = this.truncateResult(result);

      if (cacheable && !truncated.isError) {
        const cacheKey = ToolExecutionPipeline.generateKey(tool.name, params);
        await this.cache.set(cacheKey, truncated);
      }

      // 8. Post-tool-use hooks (observation only)
      for (const hook of this.hooks.post ?? []) {
        try {
          await hook({ tool: tool.name, params, result: truncated });
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

    try {
      return await Promise.race([
        tool.execute(params, context, { confirm: options?.confirm }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
