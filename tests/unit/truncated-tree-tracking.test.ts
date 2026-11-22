import { describe, it, expect } from "vitest";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { DEFAULT_LIMITS } from "@/shared/limits";

describe("Truncated Tree and Unresolved Subtree Tracking", () => {
  it("tracks unresolvedSubtrees when GitHub tree is truncated and a subtree fetch fails", async () => {
    const pool = new GitHubTokenPool([]);
    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: pool,
      limits: DEFAULT_LIMITS,
      fetchImpl: (async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("/repos/org/repo") && !urlStr.includes("trees") && !urlStr.includes("contents") && !urlStr.includes("tarball")) {
          // Repo metadata
          return new Response(JSON.stringify({ default_branch: "main", size: 100 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.includes("git/trees/main") && urlStr.includes("recursive=1")) {
          // Truncated tree response
          return new Response(
            JSON.stringify({
              sha: "main-sha",
              truncated: true,
              tree: [],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("git/trees/main") && !urlStr.includes("recursive=1")) {
          // Root tree returning one subfolder
          return new Response(
            JSON.stringify({
              sha: "root-sha",
              truncated: false,
              tree: [
                { path: "subfolder", type: "tree", sha: "subfolder-sha" },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("subfolder-sha")) {
          // Subtree fetch fails with 500
          return new Response(JSON.stringify({ message: "Server Error" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    // Since rawTreeEntries was 0 after the only subtree failed, it returns GITHUB_TREE_TRUNCATED
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("GITHUB_TREE_TRUNCATED");
      expect(result.error.stage).toBe("tree");
      expect(result.error.details?.unresolvedSubtrees).toEqual(["subfolder"]);
    }
  });

  it("includes unresolvedSubtrees in coverage metadata when partial tree succeeds", async () => {
    const pool = new GitHubTokenPool([]);
    const provider = new GitHubPublicRepositoryProvider({
      tokenPool: pool,
      limits: DEFAULT_LIMITS,
      fetchImpl: (async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("/repos/org/repo") && !urlStr.includes("trees") && !urlStr.includes("contents") && !urlStr.includes("tarball")) {
          return new Response(JSON.stringify({ default_branch: "main", size: 100 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.includes("git/trees/main") && urlStr.includes("recursive=1")) {
          return new Response(
            JSON.stringify({
              sha: "main-sha",
              truncated: true,
              tree: [],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("git/trees/main") && !urlStr.includes("recursive=1")) {
          return new Response(
            JSON.stringify({
              sha: "root-sha",
              truncated: false,
              tree: [
                { path: "src", type: "tree", sha: "src-sha" },
                { path: "legacy", type: "tree", sha: "legacy-sha" },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("src-sha")) {
          return new Response(
            JSON.stringify({
              sha: "src-sha",
              truncated: false,
              tree: [
                { path: "index.ts", type: "blob", sha: "blob-1", size: 50 },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (urlStr.includes("legacy-sha")) {
          // Fails
          return new Response(JSON.stringify({ message: "Legacy tree error" }), { status: 500 });
        }
        if (urlStr.includes("contents/src/index.ts")) {
          return new Response(
            JSON.stringify({
              content: Buffer.from("export const a = 1;").toString("base64"),
              encoding: "base64",
              size: 20,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }) as typeof fetch,
    });

    const result = await provider.getSnapshot({
      owner: "org",
      name: "repo",
      url: "https://github.com/org/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coverage?.treeTruncated).toBe(true);
      expect(result.value.coverage?.unresolvedSubtrees).toContain("legacy");
    }
  });
});
