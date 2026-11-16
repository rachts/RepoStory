import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { DEFAULT_LIMITS } from "@/shared/limits";

describe("Pre-flight Large Repository Guard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails with REPO_TOO_LARGE before downloading content when blob count exceeds threshold", async () => {
    const pool = new GitHubTokenPool([]);
    let blobFetchAttempted = false;

    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: pool,
      limits: {
        ...DEFAULT_LIMITS,
        maxPreflightFiles: 5, // Set low limit for testing
      },
      fetchImpl: (async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("tarball") || urlStr.includes("contents/")) {
          blobFetchAttempted = true;
          return new Response("content", { status: 200 });
        }
        if (urlStr.includes("git/trees/")) {
          // Return 10 blobs (exceeding limit of 5)
          const tree = Array.from({ length: 10 }, (_, i) => ({
            path: `file-${i}.ts`,
            type: "blob",
            sha: `sha-${i}`,
            size: 100,
          }));
          return new Response(
            JSON.stringify({
              sha: "tree-sha",
              truncated: false,
              tree,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        // Metadata
        return new Response(JSON.stringify({ default_branch: "main", size: 1000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot({
      owner: "giant-org",
      name: "giant-repo",
      url: "https://github.com/giant-org/giant-repo",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_TOO_LARGE");
      expect(result.error.stage).toBe("tree");
      expect(result.error.details?.blobCount).toBe(10);
      expect(result.error.details?.preflightThreshold).toBe(5);
    }

    // Verify blob or archive fetch was NEVER attempted
    expect(blobFetchAttempted).toBe(false);
  });

  it("samples repository files when REPO_STORY_LARGE_REPO_MODE=sample", async () => {
    process.env.REPO_STORY_LARGE_REPO_MODE = "sample";
    const pool = new GitHubTokenPool([]);

    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: pool,
      limits: {
        ...DEFAULT_LIMITS,
        maxPreflightFiles: 3,
      },
      fetchImpl: (async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("git/trees/")) {
          const tree = Array.from({ length: 8 }, (_, i) => ({
            path: `file-${i}.ts`,
            type: "blob",
            sha: `sha-${i}`,
            size: 100,
          }));
          return new Response(
            JSON.stringify({
              sha: "tree-sha",
              truncated: false,
              tree,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("contents/")) {
          return new Response(
            JSON.stringify({
              content: Buffer.from("export const x = 1;").toString("base64"),
              encoding: "base64",
              size: 20,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ default_branch: "main", size: 1000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot({
      owner: "giant-org",
      name: "giant-repo",
      url: "https://github.com/giant-org/giant-repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coverage?.warnings?.some((w) => w.includes("sampled analysis mode"))).toBe(true);
      expect(result.value.files.length).toBeLessThanOrEqual(3);
    }
  });
});
