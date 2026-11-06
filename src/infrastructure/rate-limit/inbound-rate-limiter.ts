export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms
}

export interface InboundRateLimiter {
  limit(identifier: string): Promise<RateLimitResult>;
}

export class InMemoryRateLimiter implements InboundRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  public constructor(options: { maxRequests?: number; windowMs?: number } = {}) {
    this.maxRequests = options.maxRequests ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
  }

  public async limit(identifier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const timestamps = this.windows.get(identifier) || [];
    const validTimestamps = timestamps.filter((t) => t > windowStart);

    if (validTimestamps.length >= this.maxRequests) {
      const oldest = validTimestamps[0] ?? windowStart;
      const resetAt = oldest + this.windowMs;
      return {
        success: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt,
      };
    }

    validTimestamps.push(now);
    this.windows.set(identifier, validTimestamps);

    return {
      success: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - validTimestamps.length,
      resetAt: now + this.windowMs,
    };
  }

  public reset(): void {
    this.windows.clear();
  }
}

let defaultLimiter: InboundRateLimiter | undefined;

export function getInboundRateLimiter(): InboundRateLimiter {
  if (defaultLimiter) return defaultLimiter;

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (redisUrl && redisToken) {
    try {
      // Dynamic import or construction of Upstash Ratelimit
      const { Ratelimit } = require("@upstash/ratelimit");
      const { Redis } = require("@upstash/redis");
      const redis = new Redis({ url: redisUrl, token: redisToken });
      const ratelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, "60 s"),
        prefix: "repo_story_ratelimit",
      });

      defaultLimiter = {
        async limit(identifier: string): Promise<RateLimitResult> {
          const res = await ratelimit.limit(identifier);
          return {
            success: res.success,
            limit: res.limit,
            remaining: res.remaining,
            resetAt: res.reset,
          };
        },
      };
      return defaultLimiter;
    } catch {
      // Fallback to in-memory on error
    }
  }

  defaultLimiter = new InMemoryRateLimiter({ maxRequests: 10, windowMs: 60_000 });
  return defaultLimiter;
}
