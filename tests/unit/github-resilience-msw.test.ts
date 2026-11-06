import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { GitHubCircuitBreaker } from "@/infrastructure/providers/github-circuit-breaker";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";

const mockMeta = {
  id: 12345,
  default_branch: "main",
  description: "Test repo",
  size: 50,
};

const mockCommit = {
  sha: "c0ffee1234567890abcdef",
};

const mockTree = {
  tree: [
    { path: "src/index.ts", type: "blob", size: 40, sha: "blob1" },
    { path: "package.json", type: "blob", size: 50, sha: "blob2" },
  ],
  truncated: false,
};

const mockContentBase64 = Buffer.from("console.log('hello');").toString("base64");

describe("Workstream 3: GitHub Resilience (MSW offline tests)", () => {
  let contentRequestCount = 0;
  let simulatedFailuresRemaining = 0;
  let simulatedFailureStatus = 429;
  let tokensUsed: string[] = [];

  const server = setupServer(
    http.get("https://api.github.com/repos/:owner/:repo", ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth) tokensUsed.push(auth);
      return HttpResponse.json(mockMeta, {
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "2000000000",
        },
      });
    }),

    http.get("https://api.github.com/repos/:owner/:repo/commits/:branch", ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth) tokensUsed.push(auth);
      return HttpResponse.json(mockCommit);
    }),

    http.get("https://api.github.com/repos/:owner/:repo/git/trees/:branch", ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth) tokensUsed.push(auth);
      return HttpResponse.json(mockTree);
    }),

    http.get("https://api.github.com/repos/:owner/:repo/contents/:path*", ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth) tokensUsed.push(auth);

      if (simulatedFailuresRemaining > 0) {
        simulatedFailuresRemaining -= 1;
        if (simulatedFailureStatus === 429) {
          return new HttpResponse(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 429,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            },
          });
        }
        // Secondary rate limit (403 with retry-after)
        return new HttpResponse(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
          status: 403,
          headers: {
            "retry-after": "60",
          },
        });
      }

      contentRequestCount += 1;
      return HttpResponse.json({
        content: mockContentBase64,
        encoding: "base64",
      });
    }),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
  afterEach(() => {
    server.resetHandlers();
    contentRequestCount = 0;
    simulatedFailuresRemaining = 0;
    tokensUsed = [];
  });
  afterAll(() => server.close());

  it("rotates tokens according to remaining quota in token pool", async () => {
    const tokenPool = new GitHubTokenPool(["token-alpha", "token-beta"]);
    // Simulate token-alpha having lower quota
    tokenPool.updateRateLimit("token-alpha", "100", "2000000000");
    tokenPool.updateRateLimit("token-beta", "500", "2000000000");

    const provider = new GitHubPublicRepositoryProvider({
      tokenPool,
      fetchImpl: fetch,
    });

    const snapshot = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(snapshot.ok).toBe(true);
    // Request should pick token-beta since 500 > 100
    expect(tokensUsed).toContain("Bearer token-beta");
  });

  it("trips circuit breaker after 3 consecutive rate-limit failures (primary 429 and secondary 403)", async () => {
    simulatedFailuresRemaining = 5;
    simulatedFailureStatus = 429;

    const circuitBreaker = new GitHubCircuitBreaker({ maxConsecutiveFailures: 3 });
    const provider = new GitHubPublicRepositoryProvider({
      circuitBreaker,
      fetchImpl: fetch,
      token: "test-token",
    });

    const snapshot = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(snapshot.error.retryable).toBe(true);
      expect(snapshot.error.details?.retryAt).toBeDefined();
    }

    // Circuit breaker is now open: immediate rejection
    expect(circuitBreaker.isOpen()).toBe(true);
    expect(() => circuitBreaker.check()).toThrowError(/circuit breaker is open/i);
  });

  it("secondary rate limit (403 + Retry-After) also increments circuit breaker failures", async () => {
    simulatedFailuresRemaining = 3;
    simulatedFailureStatus = 403;

    const circuitBreaker = new GitHubCircuitBreaker({ maxConsecutiveFailures: 3 });
    const provider = new GitHubPublicRepositoryProvider({
      circuitBreaker,
      fetchImpl: fetch,
      token: "test-token",
    });

    const snapshot = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(snapshot.ok).toBe(false);
    expect(circuitBreaker.isOpen()).toBe(true);
  });

  it("second analysis of the exact same commit makes zero content requests due to CacheStore", async () => {
    const cacheStore = new InMemoryCacheStore();
    const provider = new GitHubPublicRepositoryProvider({
      cacheStore,
      fetchImpl: fetch,
      token: "cache-test-token",
    });

    // First analysis: fetches metadata, commit, tree, and content for 2 files
    const firstResult = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });
    expect(firstResult.ok).toBe(true);
    expect(contentRequestCount).toBe(2);

    // Reset content request counter
    contentRequestCount = 0;

    // Second analysis of the same commit: tree and all files should hit cache
    const secondResult = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });
    expect(secondResult.ok).toBe(true);
    // EXACT acceptance requirement: makes ZERO content requests!
    expect(contentRequestCount).toBe(0);
  });
});
