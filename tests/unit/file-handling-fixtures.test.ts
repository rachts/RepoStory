import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { decodeFileBuffer, detectCaseCollisions } from "@/analysis/file-decoder";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import type { RepositoryFile } from "@/domain/repository";

describe("Workstream 5: File Handling for Real-World Repositories", () => {
  const fixturesDir = path.join(process.cwd(), "test", "fixtures");

  it("5a. detects Git LFS pointer files and skips them with 'lfs-pointer' coverage entry", () => {
    const lfsBuffer = fs.readFileSync(path.join(fixturesDir, "lfs-pointer.txt"));
    const decodedDefault = decodeFileBuffer(lfsBuffer, { fetchLfs: false });
    expect(decodedDefault.ok).toBe(false);
    expect(decodedDefault.reason).toBe("lfs-pointer");

    // When FETCH_LFS is enabled but file exceeds max size
    const decodedLarge = decodeFileBuffer(lfsBuffer, { fetchLfs: true, maxLfsBytes: 10 });
    expect(decodedLarge.ok).toBe(false);
    expect(decodedLarge.reason).toBe("too-large");
  });

  it("5b. detects tree submodules (mode 160000) and records 'submodule' in coverage", async () => {
    const submoduleJson = JSON.parse(fs.readFileSync(path.join(fixturesDir, "submodule-entry.json"), "utf8"));

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/repos/acme/submodule-app")) {
          return new Response(JSON.stringify({ id: 101, default_branch: "main", size: 50 }));
        }
        if (url.includes("/git/trees/main")) {
          return new Response(JSON.stringify({
            sha: "main-sha",
            tree: [
              submoduleJson,
              { path: "src/index.ts", mode: "100644", type: "blob", size: 30 },
            ],
          }));
        }
        if (url.includes("/contents/src/index.ts")) {
          return new Response(JSON.stringify({
            content: Buffer.from("export const x = 1;").toString("base64"),
            encoding: "base64",
          }));
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const result = await provider.getSnapshot({ owner: "acme", name: "submodule-app", url: "https://github.com/acme/submodule-app" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.coverage?.filesSkippedByReason?.submodule).toBe(1);
    expect(result.value.coverage?.filesSkippedDetails).toContainEqual(
      expect.objectContaining({ path: "libs/submodule-repo", reason: "submodule" }),
    );
  });

  it("5c. streams AsyncIterable<RepositoryFile> in runAnalysis and computes analyzedPercent", async () => {
    const store = new InMemoryAnalysisStore({ isScratch: true });

    async function* fileGenerator(): AsyncIterable<RepositoryFile> {
      yield { path: "src/app.ts", type: "file", content: "export const app = 'test';", isAnalyzable: true };
      yield { path: "package.json", type: "file", content: JSON.stringify({ name: "stream-app" }), isAnalyzable: true };
    }

    const dummyProvider = new GitHubPublicRepositoryProvider();
    const result = await runAnalysis(
      { owner: "acme", name: "streaming-app", url: "https://github.com/acme/streaming-app" },
      dummyProvider,
      store,
      { files: fileGenerator() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.filesAnalyzed).toBe(2);
    expect(result.value.coverage?.analyzedPercent).toBe(100);
    expect(result.value.coverage?.filesSkipped).toBe(0);
  });

  it("5d. decodes UTF-16 files with BOM correctly without crashing", () => {
    const utf16Buffer = fs.readFileSync(path.join(fixturesDir, "utf16-file.ts"));
    const decoded = decodeFileBuffer(utf16Buffer);

    expect(decoded.ok).toBe(true);
    expect(decoded.encoding).toBe("utf-16le");
    expect(decoded.content).toContain('export const message = "hello from utf-16";');
  });

  it("5d. marks binary files with .py extension as unsupported-encoding in coverage without crashing", () => {
    const binaryPy = fs.readFileSync(path.join(fixturesDir, "binary.py"));
    const decoded = decodeFileBuffer(binaryPy);

    expect(decoded.ok).toBe(false);
    expect(decoded.reason).toBe("unsupported-encoding");
  });

  it("5d. detects case-insensitive path collisions and records warning and coverage entry", () => {
    const paths = ["README.md", "src/index.ts", "readme.md"];
    const { collisions, warnings, safePaths } = detectCaseCollisions(paths);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toEqual({ path: "readme.md", reason: "path-collision" });
    expect(warnings[0]).toContain('Case-insensitive path collision detected between "README.md" and "readme.md".');
    expect(safePaths.has("README.md")).toBe(true);
    expect(safePaths.has("readme.md")).toBe(false);
  });

  it("5c. handles 20,000-entry tree gracefully with partial coverage instead of failing", async () => {
    const largeTree = JSON.parse(fs.readFileSync(path.join(fixturesDir, "large-tree-20k.json"), "utf8"));

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/repos/acme/large-app")) {
          return new Response(JSON.stringify({ id: 202, default_branch: "main", size: 100000 }));
        }
        if (url.includes("/git/trees/main")) {
          return new Response(JSON.stringify({ sha: "large-sha", tree: largeTree }));
        }
        if (url.includes("/contents/src/file_")) {
          return new Response(JSON.stringify({
            content: Buffer.from("export const val = 1;").toString("base64"),
            encoding: "base64",
          }));
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const result = await provider.getSnapshot({ owner: "acme", name: "large-app", url: "https://github.com/acme/large-app" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Tree was capped at soft limit (10,000 blobs), remaining 10,000 marked as limit-reached
    expect(result.value.coverage?.filesSkippedByReason?.limitReached).toBeGreaterThan(0);
    expect(result.value.coverage?.filesSkippedDetails).toContainEqual(
      expect.objectContaining({ reason: "limit-reached" }),
    );
    expect(result.value.coverage?.analyzedPercent).toBeLessThan(100);
    expect(result.value.coverage?.analyzedPercent).toBeGreaterThan(0);
  });
});
