/** Cache statistics. */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/** Cache interface. */
export interface Cache<K, V> {
  get(key: K): Promise<V | null>;
  set(key: K, value: V, ttl?: number): Promise<void>;
  delete(key: K): Promise<void>;
  clear(): Promise<void>;
  getStats(): CacheStats;
}

/** Cache configuration. */
export interface CacheConfig {
  ttl: number; // Time to live in milliseconds
  maxSize: number; // Maximum number of entries
  strategy: 'lru' | 'lfu' | 'fifo'; // Eviction strategy
}