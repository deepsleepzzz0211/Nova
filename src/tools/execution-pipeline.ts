import type { ToolContext, ToolResult } from './types.js';
import type { Tool } from './types.js';
import type { ToolResultCache } from '../cache/tool-result-cache.js';
import type { PermissionPolicy } from '../permission/policy.js';

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

/**
 * The single execution path for every tool invocation.
 *
 * Order of checks (permission always precedes cache):
 *  1. PermissionPolicy decision → deny → error result
 *  2. decision ask → user confirmation (or deny when no callback)
 *  3. tool.requiresPermission → treated as ask
 *  4. cache lookup for cacheable tools
 *  5. execute with timeout
 *  6. cache successful results of cacheable tools
 */
export class ToolExecutionPipeline {
  private readonly cache: ToolResultCache;
  private readonly permissionChecker: PermissionPolicy;

  constructor(cache: ToolResultCache, permissionChecker: PermissionPolicy) {
    this.cache = cache;
    this.permissionChecker = permissionChecker;
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

    // 4. Cache lookup (cacheable tools only, after permission checks)
    const cacheable = tool.metadata?.cacheable ?? false;
    if (cacheable) {
      const cacheKey = ToolExecutionPipeline.generateKey(tool.name, params);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // 5-6. Execute with timeout and cache successful results
    try {
      const timeout = tool.metadata?.timeout ?? DEFAULT_TIMEOUT_MS;
      const result = await this.executeWithTimeout(tool, params, context, timeout);

      if (cacheable && !result.isError) {
        const cacheKey = ToolExecutionPipeline.generateKey(tool.name, params);
        await this.cache.set(cacheKey, result);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Tool execution failed: ${message}`,
        isError: true,
      };
    }
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
      return await Promise.race([tool.execute(params, context), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }
}
