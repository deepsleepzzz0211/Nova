/**
 * Minimal LRU keyed by source string with a secondary character budget
 * (md-structured-inline 03 review: the inline and block caches shared the
 * same touch-then-evict loop by copy — one implementation now).
 */
export class StringLru<V> {
  #map = new Map<string, V>();
  #chars = 0;

  constructor(
    private readonly capacity: number,
    private readonly charBudget: number,
    private readonly keyCost: (key: string) => number = (k) => k.length,
  ) {}

  get(key: string): V | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    if (!this.#map.has(key)) this.#chars += this.keyCost(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    this.#evict();
  }

  #evict(): void {
    while (
      this.#map.size > this.capacity ||
      (this.#chars > this.charBudget && this.#map.size > 1)
    ) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#chars -= this.keyCost(oldest);
      this.#map.delete(oldest);
    }
  }

  get size(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
    this.#chars = 0;
  }
}
