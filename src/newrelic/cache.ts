type CacheEntry<T> = {
  readonly expiresAt: number;
  readonly value: T;
};

/** Small insertion-ordered TTL cache. Disabled when ttlMs or maxEntries is zero. */
export class TtlCache<T> {
  readonly ttlMs: number;
  readonly maxEntries: number;
  #entries = new Map<string, CacheEntry<T>>();

  constructor(ttlMs = 0, maxEntries = 0) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0)
      throw new RangeError('Cache TTL must be non-negative');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError('Cache entry limit must be non-negative');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    // Promote to make eviction least-recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (!this.enabled) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
