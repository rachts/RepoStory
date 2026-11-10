import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { GitHubCircuitBreaker } from "@/infrastructure/providers/github-circuit-breaker";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";

async function createMockTarGz(files: Record<string, string>, rootDir = "org-repo-c0ffee/"): Promise<Buffer> {
  const pack = tar.pack();
  for (const [path, content] of Object.entries(files)) {
    pack.entry({ name: `${rootDir}${path}` }, content);
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    pack.on("data", (chunk: unknown) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)));
    pack.on("end", () => {
      resolve(gzipSync(Buffer.concat(chunks)));
    });
    pack.on("error", reject);
  });
}

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
  let treeRequestCount = 0;
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
      treeRequestCount += 1;
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
    treeRequestCount = 0;
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

  it("second analysis of the exact same commit makes zero content and zero tree requests", async () => {
    const cacheStore = new InMemoryCacheStore();
    const provider = new GitHubPublicRepositoryProvider({
      cacheStore,
      fetchImpl: fetch,
      token: "cache-test-token",
    });

    const commitSha = "c0ffee1234567890abcdef";

    // First analysis: fetches metadata, tree, and content
    const firstResult = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      branch: commitSha,
      url: "https://github.com/org/repo",
    });
    expect(firstResult.ok).toBe(true);
    expect(treeRequestCount).toBe(1);

    // Reset counters
    treeRequestCount = 0;
    contentRequestCount = 0;

    // Second analysis of the exact same commit: tree and content should hit cache
    const secondResult = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      branch: commitSha,
      url: "https://github.com/org/repo",
    });
    expect(secondResult.ok).toBe(true);
    // EXACT acceptance requirement: makes ZERO tree and ZERO content requests!
    expect(treeRequestCount).toBe(0);
    expect(contentRequestCount).toBe(0);
  });

  it("follows safe 301/302 redirects within api.github.com (e.g. org/repo rename)", async () => {
    server.use(
      http.get("https://api.github.com/repos/facebook/react", () => {
        return new HttpResponse(null, {
          status: 301,
          headers: {
            Location: "https://api.github.com/repositories/10270250",
          },
        });
      }),
      http.get("https://api.github.com/repositories/10270250", () => {
        return HttpResponse.json(mockMeta, {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": "2000000000",
          },
        });
      }),
      http.get("https://api.github.com/repos/facebook/react/commits/:branch", () => {
        return HttpResponse.json(mockCommit);
      }),
      http.get("https://api.github.com/repos/facebook/react/git/trees/:branch", () => {
        return HttpResponse.json(mockTree);
      }),
      http.get("https://api.github.com/repos/facebook/react/contents/:path*", () => {
        return HttpResponse.json({
          content: mockContentBase64,
          encoding: "base64",
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "facebook",
      name: "react",
      url: "https://github.com/facebook/react",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repository.name).toBe("react");
    }
  });

  it("rejects redirects that target an unauthorized external host", async () => {
    server.use(
      http.get("https://api.github.com/repos/attacker/malicious", () => {
        return new HttpResponse(null, {
          status: 301,
          headers: {
            Location: "https://evil.attacker.com/steal-creds",
          },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "attacker",
      name: "malicious",
      url: "https://github.com/attacker/malicious",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_INACCESSIBLE");
      expect(result.error.message).toMatch(/unauthorized external host/i);
    }
  });

  it("aborts when redirects exceed maxRedirects", async () => {
    server.use(
      http.get("https://api.github.com/repos/loop/repo", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://api.github.com/repositories/loop-1" },
        });
      }),
      http.get("https://api.github.com/repositories/loop-1", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://api.github.com/repositories/loop-2" },
        });
      }),
      http.get("https://api.github.com/repositories/loop-2", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://api.github.com/repositories/loop-3" },
        });
      }),
      http.get("https://api.github.com/repositories/loop-3", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://api.github.com/repositories/loop-4" },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "loop",
      name: "repo",
      url: "https://github.com/loop/repo",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_INACCESSIBLE");
      expect(result.error.message).toMatch(/too many times/i);
    }
  });

  it("fetches file contents in bulk via tarball archive streaming with codeload redirect", async () => {
    const tarGz = await createMockTarGz({
      "src/index.ts": "console.log('from archive');",
      "package.json": JSON.stringify({ name: "archive-pkg", version: "1.0.0" }),
    });

    server.use(
      http.get("https://api.github.com/repos/org/repo/tarball/:ref", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: {
            Location: "https://codeload.github.com/org/repo/legacy.tar.gz/c0ffee",
          },
        });
      }),
      http.get("https://codeload.github.com/org/repo/legacy.tar.gz/:ref", () => {
        return new HttpResponse(tarGz, {
          status: 200,
          headers: {
            "content-type": "application/x-gzip",
          },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "archive-token",
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBe(2);
      expect(result.value.files.map((f) => f.path)).toEqual(["package.json", "src/index.ts"]);
      expect(result.value.files.find((f) => f.path === "src/index.ts")?.content).toBe("console.log('from archive');");
      expect(result.value.coverage?.contentFetchStrategy).toBe("archive");
      expect(result.value.coverage?.usedFallbackContentFetch).toBe(false);
      // Zero per-file /contents requests made!
      expect(contentRequestCount).toBe(0);
    }
  });

  it("allows codeload.github.com redirect exclusively for archive endpoint and rejects it for non-archive stages", async () => {
    server.use(
      http.get("https://api.github.com/repos/org/escape-metadata", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: {
            Location: "https://codeload.github.com/org/escape-metadata",
          },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "escape-metadata",
      url: "https://github.com/org/escape-metadata",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_INACCESSIBLE");
      expect(result.error.message).toMatch(/unauthorized external host/i);
    }
  });

  it("rejects unauthorized external host redirects on archive endpoint", async () => {
    server.use(
      http.get("https://api.github.com/repos/org/repo/tarball/:ref", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: {
            Location: "https://evil.attacker.com/malicious.tar.gz",
          },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    // Should fall back to per-file or fail safely without following evil host
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coverage?.usedFallbackContentFetch).toBe(true);
      expect(result.value.coverage?.contentFetchStrategy).toBe("per-file");
      expect(contentRequestCount).toBe(2);
    }
  });

  it("enforces per-file size caps during archive streaming", async () => {
    const bigContent = "X".repeat(5000);
    const tarGz = await createMockTarGz({
      "src/index.ts": bigContent,
      "package.json": JSON.stringify({ name: "small-pkg" }),
    });

    server.use(
      http.get("https://api.github.com/repos/org/repo/tarball/:ref", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: {
            Location: "https://codeload.github.com/org/repo/legacy.tar.gz/c0ffee",
          },
        });
      }),
      http.get("https://codeload.github.com/org/repo/legacy.tar.gz/:ref", () => {
        return new HttpResponse(tarGz, {
          status: 200,
          headers: {
            "content-type": "application/x-gzip",
          },
        });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "size-token",
      limits: {
        maxFiles: 100,
        maxFileBytes: 1000,
        maxTotalBytes: 50_000,
        maxContentBytes: 1000, // < 5000 bytes
        maxEvidenceExcerpt: 100,
        maxAnalysisMs: 10_000,
      },
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBe(1);
      expect(result.value.files[0]?.path).toBe("package.json");
      expect(result.value.coverage?.filesSkippedByReason?.tooLarge).toBe(1);
    }
  });

  it("falls back to per-file content fetching when archive endpoint returns an error", async () => {
    server.use(
      http.get("https://api.github.com/repos/org/repo/tarball/:ref", () => {
        return new HttpResponse("Server error", { status: 500 });
      }),
    );

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: fetch,
      token: "test-token",
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBe(2);
      expect(result.value.coverage?.usedFallbackContentFetch).toBe(true);
      expect(result.value.coverage?.contentFetchStrategy).toBe("per-file");
      expect(contentRequestCount).toBe(2);
    }
  });

  it("falls back to per-file content fetching when REPO_STORY_FORCE_PER_FILE_FETCH is set", async () => {
    process.env.REPO_STORY_FORCE_PER_FILE_FETCH = "true";

    try {
      const provider = new GitHubPublicRepositoryProvider({
        fetchImpl: fetch,
        token: "test-token",
      });

      const result = await provider.getSnapshot({
        owner: "org",
        name: "repo",
        url: "https://github.com/org/repo",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.files.length).toBe(2);
        expect(result.value.coverage?.usedFallbackContentFetch).toBe(true);
        expect(result.value.coverage?.contentFetchStrategy).toBe("per-file");
        expect(contentRequestCount).toBe(2);
      }
    } finally {
      delete process.env.REPO_STORY_FORCE_PER_FILE_FETCH;
    }
  });
});
