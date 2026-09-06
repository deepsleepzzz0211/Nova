import type { ToolResult } from '../tools/types.js';
import type { Cache, CacheStats } from './types.js';
import { MemoryCache } from './memory-cache.js';

/** Cache for tool execution results. */
export class ToolResultCache implements Cache<string, ToolResult> {
  private cache: MemoryCache<string, ToolResult>;

  constructor(ttl: number = 5 * 60 * 1000) { // 5 minutes default
    this.cache = new MemoryCache({ ttl, maxSize: 500 });
  }

  async get(key: string): Promise<ToolResult | null> {
    return this.cache.get(key);
  }

  async set(key: string, value: ToolResult): Promise<void> {
    await this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(key);
  }

  async clear(): Promise<void> {
    await this.cache.clear();
  }

  getStats(): CacheStats {
    return this.cache.getStats();
  }

  /** Generate cache key from tool name and parameters. */
  static generateKey(toolName: string, params: Record<string, unknown>): string {
    const paramsHash = JSON.stringify(params);
    return `${toolName}:${paramsHash}`;
  }
}