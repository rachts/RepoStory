import { describe, it, expect } from "vitest";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { DEFAULT_LIMITS } from "@/shared/limits";

describe("GitHub Token Override and Isolation", () => {
  it("uses server tokens by default and prioritizes user override token when provided", () => {
    const pool = new GitHubTokenPool(["server_token_1", "server_token_2"]);
    const defaultToken = pool.getBestToken();
    expect(["server_token_1", "server_token_2"]).toContain(defaultToken);

    // When an override token is passed, it returns the override token
    const userOverride = "ghp_userProvidedSecretToken12345";
    expect(pool.getBestToken(userOverride)).toBe(userOverride);

    // Isolation check: a subsequent request without an override does NOT get the user token
    const nextRequestToken = pool.getBestToken();
    expect(nextRequestToken).not.toBe(userOverride);
    expect(["server_token_1", "server_token_2"]).toContain(nextRequestToken);
  });

  it("handles rate limit updates on override tokens without polluting server token pool", () => {
    const pool = new GitHubTokenPool(["server_token_1"]);
    const userToken = "ghp_userTokenABC";

    pool.updateRateLimit(userToken, 0, Date.now() + 60_000);
    // User token is exhausted so it falls back to server token, not returning userToken
    expect(pool.getBestToken(userToken)).toBe("server_token_1");

    // In an empty pool, an exhausted user token yields undefined
    const emptyPool = new GitHubTokenPool([]);
    emptyPool.updateRateLimit(userToken, 0, Date.now() + 60_000);
    expect(emptyPool.getBestToken(userToken)).toBeUndefined();

    // Server token is unaffected
    expect(pool.getBestToken()).toBe("server_token_1");
  });

  it("returns REPOSITORY_NOT_FOUND_OR_PRIVATE on 404 when unauthenticated", async () => {
    const emptyPool = new GitHubTokenPool([]);
    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: emptyPool,
      limits: DEFAULT_LIMITS,
      fetchImpl: (async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot({
      owner: "private-org",
      name: "secret-repo",
      url: "https://github.com/private-org/secret-repo",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_NOT_FOUND_OR_PRIVATE");
      expect(result.error.stage).toBe("fetch");
      expect(result.error.hint).toContain("Make the repository public or sign in");
    }
  });

  it("returns REPOSITORY_NOT_FOUND on 404 when authenticated with an override token", async () => {
    const emptyPool = new GitHubTokenPool([]);
    const userToken = "ghp_testUserToken";
    let capturedAuthHeader: string | null = null;

    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: emptyPool,
      limits: DEFAULT_LIMITS,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        capturedAuthHeader = headers.get("authorization");
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot(
      {
        owner: "some-org",
        name: "missing-repo",
        url: "https://github.com/some-org/missing-repo",
      },
      undefined,
      undefined,
      undefined,
      { token: userToken },
    );

    expect(capturedAuthHeader).toBe(`Bearer ${userToken}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
      expect(result.error.stage).toBe("fetch");
    }
  });
});
