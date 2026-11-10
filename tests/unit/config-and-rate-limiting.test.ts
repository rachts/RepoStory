import { describe, expect, it } from "vitest";
import { validateEnv } from "@/config/env";
import { assertProductionGuards, getProductionConfigError } from "@/config/production-guards";
import { InMemoryRateLimiter } from "@/infrastructure/rate-limit/inbound-rate-limiter";

describe("Workstream 8: Configuration validation and inbound rate limiting", () => {
  describe("Config validation fail-fast", () => {
    it("fails fast in production when SUPABASE credentials and in-memory bypass are missing, listing missing variables clearly", () => {
      const prodEnv: Record<string, string | undefined> = {
        NODE_ENV: "production",
        // SUPABASE_URL and SUPABASE_SECRET_KEY missing
        // NEXTAUTH_SECRET missing
      };

      const result = validateEnv(prodEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("[RepoStory Config Error] Missing or invalid configuration variables:");
        expect(result.error).toContain("SUPABASE_URL");
        expect(result.error).toContain("NEXTAUTH_SECRET");
      }
    });

    it("passes validation in production when required credentials are provided", () => {
      const validProdEnv: Record<string, string | undefined> = {
        NODE_ENV: "production",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "secret-key-xyz",
        NEXTAUTH_SECRET: "long-secure-random-nextauth-secret-string",
      };

      const result = validateEnv(validProdEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.env.NODE_ENV).toBe("production");
        expect(result.env.SUPABASE_URL).toBe("https://example.supabase.co");
      }
    });

    it("passes validation in production when explicitly bypassing in-memory queue & store", () => {
      const bypassEnv: Record<string, string | undefined> = {
        NODE_ENV: "production",
        ALLOW_IN_MEMORY_STORE: "true",
        ALLOW_IN_MEMORY_QUEUE: "true",
        NEXTAUTH_SECRET: "long-secure-random-nextauth-secret-string",
      };

      const result = validateEnv(bypassEnv);
      expect(result.ok).toBe(true);
    });

    it("provides safe defaults in development mode", () => {
      const devEnv: Record<string, string | undefined> = {
        NODE_ENV: "development",
      };

      const result = validateEnv(devEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.env.REPO_STORY_MAX_ANALYSES).toBe(100);
        expect(result.env.ANALYSIS_DAILY_QUOTA).toBe(5);
        expect(result.env.GROQ_MODEL).toBe("openai/gpt-oss-120b");
      }
    });
  });

  describe("Production start guards (fail-fast assertions)", () => {
    it("refuses to start in production if REPO_STORY_JOB_STORE is unset", () => {
      expect(() => {
        assertProductionGuards({
          NODE_ENV: "production",
          // REPO_STORY_JOB_STORE unset
        }, false);
      }).toThrow(/In production, REPO_STORY_JOB_STORE must be explicitly set/);
    });

    it("refuses to start in production if ALLOW_IN_MEMORY_QUEUE is unset when running in-memory queue", () => {
      expect(() => {
        assertProductionGuards({
          NODE_ENV: "production",
          REPO_STORY_JOB_STORE: "memory",
          // ALLOW_IN_MEMORY_QUEUE unset
          ALLOW_IN_MEMORY_STORE: "true",
        }, false);
      }).toThrow(/InMemoryJobQueue is not allowed in production unless ALLOW_IN_MEMORY_QUEUE=true/);
    });

    it("starts without error in production when REPO_STORY_JOB_STORE=supabase and Supabase credentials are present", () => {
      expect(() => {
        assertProductionGuards({
          NODE_ENV: "production",
          REPO_STORY_JOB_STORE: "supabase",
          SUPABASE_URL: "https://xyz.supabase.co",
          SUPABASE_SECRET_KEY: "prod-secret-key-123",
        }, false);
      }).not.toThrow();
    });

    it("starts without error in production when REPO_STORY_JOB_STORE=file and ALLOW_IN_MEMORY_QUEUE=true", () => {
      expect(() => {
        assertProductionGuards({
          NODE_ENV: "production",
          REPO_STORY_JOB_STORE: "file",
          ALLOW_IN_MEMORY_QUEUE: "true",
        }, false);
      }).not.toThrow();
    });

    it("refuses to start in production if REPO_STORY_JOB_STORE has an unsupported value", () => {
      expect(() => {
        assertProductionGuards({
          NODE_ENV: "production",
          REPO_STORY_JOB_STORE: "redis-unsupported",
        }, false);
      }).toThrow(/REPO_STORY_JOB_STORE must be set to 'supabase', 'file', or 'memory'/);
    });

    it("returns structured CONFIG_ERROR via getProductionConfigError when config is missing", () => {
      const error = getProductionConfigError({
        NODE_ENV: "production",
        // REPO_STORY_JOB_STORE unset
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("CONFIG_ERROR");
      expect(error?.message).toMatch(/In production, REPO_STORY_JOB_STORE must be explicitly set/);
    });

    it("returns null via getProductionConfigError when valid", () => {
      const error = getProductionConfigError({
        NODE_ENV: "production",
        REPO_STORY_JOB_STORE: "supabase",
        SUPABASE_URL: "https://xyz.supabase.co",
        SUPABASE_SECRET_KEY: "prod-secret-key-123",
      });
      expect(error).toBeNull();
    });
  });

  describe("Inbound rate limiting (10 requests per minute)", () => {
    it("allows 10 requests per minute and blocks the 11th request with Retry-After", async () => {
      const limiter = new InMemoryRateLimiter({ maxRequests: 10, windowMs: 60_000 });
      const testIdentifier = "test-client-ip-123";

      for (let i = 0; i < 10; i++) {
        const check = await limiter.limit(testIdentifier);
        expect(check.success).toBe(true);
        expect(check.remaining).toBe(10 - (i + 1));
      }

      // 11th request: rejected!
      const blocked = await limiter.limit(testIdentifier);
      expect(blocked.success).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetAt).toBeGreaterThan(Date.now());
    });

    it("isolates rate limit buckets between different users / IPs", async () => {
      const limiter = new InMemoryRateLimiter({ maxRequests: 2, windowMs: 60_000 });

      // User A exhausts their limit
      await limiter.limit("user:alice");
      await limiter.limit("user:alice");
      const aliceBlocked = await limiter.limit("user:alice");
      expect(aliceBlocked.success).toBe(false);

      // User B is unaffected
      const bobCheck = await limiter.limit("user:bob");
      expect(bobCheck.success).toBe(true);
    });
  });
});
