import type { CacheStore } from "@/application/cache/cache-store";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly defaultTtlMs: number;

  public constructor(options: { defaultTtlMs?: number } = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 3_600_000;
  }

  public async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return structuredClone(entry.value) as T;
  }

  public async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, {
      value: structuredClone(value),
      expiresAt: Date.now() + ttl,
    });
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }
}
