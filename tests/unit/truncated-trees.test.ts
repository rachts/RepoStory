import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";

const mockMeta = {
  id: 8888,
  default_branch: "main",
  description: "Truncated repo test",
  size: 50,
};

describe("Workstream 6: Truncated Git Trees Fallback (MSW offline tests)", () => {
  let subtreeShouldFail = false;

  const server = setupServer(
    http.get("https://api.github.com/repos/:owner/:repo", () => {
      return HttpResponse.json(mockMeta, {
        headers: {
          "x-ratelimit-remaining": "5000",
          "x-ratelimit-reset": "2000000000",
        },
      });
    }),

    http.get("https://api.github.com/repos/:owner/:repo/git/trees/:branchOrSha", ({ request, params }) => {
      const url = new URL(request.url);
      const isRecursive = url.searchParams.get("recursive") === "1";
      const branchOrSha = params.branchOrSha as string;

      // Initial recursive root tree call returns truncated: true
      if (branchOrSha === "main" && isRecursive) {
        return HttpResponse.json({
          sha: "main-sha",
          truncated: true,
          tree: [],
        });
      }

      // Fallback non-recursive root tree call
      if (branchOrSha === "main" && !isRecursive) {
        return HttpResponse.json({
          sha: "main-sha",
          truncated: false,
          tree: [
            { path: "src", type: "tree", sha: "src-sha" },
            { path: "package.json", type: "blob", size: 60, sha: "pkg-sha" },
          ],
        });
      }

      // Subtree call for 'src'
      if (branchOrSha === "src-sha") {
        if (subtreeShouldFail) {
          return new HttpResponse("Subtree internal server error", { status: 500 });
        }
        return HttpResponse.json({
          sha: "src-sha",
          truncated: false,
          tree: [
            { path: "index.ts", type: "blob", size: 80, sha: "idx-sha" },
            { path: "utils.ts", type: "blob", size: 90, sha: "utl-sha" },
          ],
        });
      }

      return new HttpResponse("Not found", { status: 404 });
    }),

    http.get("https://api.github.com/repos/:owner/:repo/contents/:path*", ({ params }) => {
      const rawPath = params.path;
      const filePath = Array.isArray(rawPath) ? rawPath.join("/") : rawPath || "";
      const content = `// Content for ${filePath}`;
      return HttpResponse.json({
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      });
    }),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    server.resetHandlers();
    subtreeShouldFail = false;
  });
  afterAll(() => server.close());

  it("recovers from truncated: true by resolving top-level subtrees into a complete merged tree", async () => {
    subtreeShouldFail = false;
    const provider = new GitHubPublicRepositoryProvider();
    const result = await provider.getSnapshot({
      owner: "acme",
      name: "big-repo",
      url: "https://github.com/acme/big-repo",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both package.json (root) and src/index.ts, src/utils.ts (subtree) must be present
    const paths = result.value.files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils.ts");
    expect(result.value.coverage?.treeTruncated).toBe(false);
  });

  it("degrades gracefully when subtree calls fail, analyzing available files with prominent coverage warning", async () => {
    subtreeShouldFail = true;
    const provider = new GitHubPublicRepositoryProvider();
    const result = await provider.getSnapshot({
      owner: "acme",
      name: "big-repo",
      url: "https://github.com/acme/big-repo",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Root file package.json is still analyzed
    const paths = result.value.files.map((f) => f.path);
    expect(paths).toContain("package.json");
    // Subtree src failed, so index.ts won't be present
    expect(paths).not.toContain("src/index.ts");

    // Must have prominent coverage warning and treeTruncated flag
    expect(result.value.coverage?.treeTruncated).toBe(true);
    expect(result.value.coverage?.warnings?.length).toBeGreaterThan(0);
    const hasTruncatedWarning = result.value.coverage?.warnings?.some(
      (w) => w.toLowerCase().includes("truncated") || w.toLowerCase().includes("subtree"),
    );
    expect(hasTruncatedWarning).toBe(true);
  });
});
