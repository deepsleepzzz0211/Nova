import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCache } from '../../src/cache/memory-cache.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';

describe('Cache System', () => {
  describe('MemoryCache', () => {
    let cache: MemoryCache<string, string>;

    beforeEach(() => {
      cache = new MemoryCache({ ttl: 1000, maxSize: 10 });
    });

    it('should store and retrieve values', async () => {
      await cache.set('key1', 'value1');
      const result = await cache.get('key1');
      expect(result).toBe('value1');
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should respect TTL', async () => {
      const shortCache = new MemoryCache<string, string>({ ttl: 10 });
      await shortCache.set('key1', 'value1');
      
      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 20));
      
      const result = await shortCache.get('key1');
      expect(result).toBeNull();
    });

    it('should evict when at capacity', async () => {
      const smallCache = new MemoryCache<string, string>({ ttl: 1000, maxSize: 2 });
      
      await smallCache.set('key1', 'value1');
      await smallCache.set('key2', 'value2');
      await smallCache.set('key3', 'value3'); // Should evict key1
      
      const result1 = await smallCache.get('key1');
      const result2 = await smallCache.get('key2');
      const result3 = await smallCache.get('key3');
      
      expect(result1).toBeNull();
      expect(result2).toBe('value2');
      expect(result3).toBe('value3');
    });

    it('should track statistics', async () => {
      await cache.set('key1', 'value1');
      await cache.get('key1'); // hit
      await cache.get('key2'); // miss
      
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
    });
  });

  describe('ToolResultCache', () => {
    let cache: ToolResultCache;

    beforeEach(() => {
      cache = new ToolResultCache();
    });

    it('should generate consistent cache keys', () => {
      const params = { path: '/test/file.txt', offset: 1 };
      
      const key1 = ToolResultCache.generateKey('read_file', params);
      const key2 = ToolResultCache.generateKey('read_file', params);
      
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different tools', () => {
      const params = { path: '/test/file.txt' };
      
      const key1 = ToolResultCache.generateKey('read_file', params);
      const key2 = ToolResultCache.generateKey('write_file', params);
      
      expect(key1).not.toBe(key2);
    });
  });
});