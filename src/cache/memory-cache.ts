import type { Cache, CacheStats, CacheConfig } from './types.js';

/** In-memory cache implementation with LRU eviction. */
export class MemoryCache<K, V> implements Cache<K, V> {
  private store = new Map<K, { value: V; timestamp: number; accessCount: number; ttl?: number }>();
  private config: CacheConfig;
  private stats: CacheStats = { hits: 0, misses: 0, size: 0 };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      ttl: config.ttl ?? 5 * 60 * 1000, // 5 minutes default
      maxSize: config.maxSize ?? 1000,
      strategy: config.strategy ?? 'lru',
    };
  }

  async get(key: K): Promise<V | null> {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL (per-entry ttl overrides the instance default)
    if (Date.now() - entry.timestamp > (entry.ttl ?? this.config.ttl)) {
      this.store.delete(key);
      this.stats.size--;
      this.stats.misses++;
      return null;
    }

    // Update access count and timestamp for LRU/LFU
    entry.accessCount++;
    entry.timestamp = Date.now();
    this.stats.hits++;
    return entry.value;
  }

  async set(key: K, value: V, ttl?: number): Promise<void> {
    // Evict if at capacity
    if (this.store.size >= this.config.maxSize) {
      this.evict();
    }

    this.store.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 1,
      ttl,
    });
    this.stats.size++;
  }

  async delete(key: K): Promise<void> {
    if (this.store.has(key)) {
      this.store.delete(key);
      this.stats.size--;
    }
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.stats.size = 0;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  private evict(): void {
    if (this.store.size === 0) return;

    let keyToEvict: K | null = null;

    switch (this.config.strategy) {
      case 'lru':
        // Evict least recently used (oldest timestamp)
        let oldestTime = Infinity;
        for (const [key, entry] of this.store) {
          if (entry.timestamp < oldestTime) {
            oldestTime = entry.timestamp;
            keyToEvict = key;
          }
        }
        break;

      case 'lfu':
        // Evict least frequently used (lowest access count)
        let minAccess = Infinity;
        for (const [key, entry] of this.store) {
          if (entry.accessCount < minAccess) {
            minAccess = entry.accessCount;
            keyToEvict = key;
          }
        }
        break;

      case 'fifo':
        // Evict first inserted (oldest timestamp)
        let oldestInsert = Infinity;
        for (const [key, entry] of this.store) {
          if (entry.timestamp < oldestInsert) {
            oldestInsert = entry.timestamp;
            keyToEvict = key;
          }
        }
        break;
    }

    if (keyToEvict !== null) {
      this.store.delete(keyToEvict);
      this.stats.size--;
    }
  }
}