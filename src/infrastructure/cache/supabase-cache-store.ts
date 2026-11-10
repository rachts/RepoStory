import type { CacheStore } from "@/application/cache/cache-store";

interface SupabaseCacheStoreOptions {
  url?: string;
  secretKey?: string;
  defaultTtlMs?: number;
  fetchImpl?: typeof fetch;
}

export class SupabaseCacheStore implements CacheStore {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly defaultTtlMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SupabaseCacheStoreOptions = {}) {
    this.baseUrl = `${options.url?.replace(/\/$/, "") ?? ""}/rest/v1`;
    this.secretKey = options.secretKey ?? "";
    this.defaultTtlMs = options.defaultTtlMs ?? 3_600_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): HeadersInit {
    return {
      apikey: this.secretKey,
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
    };
  }

  public async get<T>(key: string): Promise<T | undefined> {
    const nowIso = new Date().toISOString();
    const params = new URLSearchParams({
      key: `eq.${key}`,
      expires_at: `gt.${nowIso}`,
      limit: "1",
    });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/repo_story_cache?${params.toString()}`, {
        method: "GET",
        headers: this.headers(),
      });
      if (!response.ok) return undefined;
      const rows = (await response.json()) as Array<{ value: unknown }>;
      return rows[0]?.value as T | undefined;
    } catch {
      return undefined;
    }
  }

  public async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    try {
      await this.fetchImpl(`${this.baseUrl}/repo_story_cache`, {
        method: "POST",
        headers: { ...this.headers(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key,
          value,
          expires_at: expiresAt,
        }),
      });
    } catch {
      // Best-effort cache set
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/repo_story_cache?key=eq.${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch {
      // Best-effort cache delete
    }
  }
}
