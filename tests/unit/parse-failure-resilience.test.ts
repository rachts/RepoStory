import { describe, it, expect } from "vitest";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import type { RepositoryFile, RepositoryProvider } from "@/domain/repository";
import { ok } from "@/shared/result";

describe("AST Parse Failure Resilience", () => {
  it("continues analysis when a file throws during AST parsing and records it in coverage", async () => {
    const store = new InMemoryAnalysisStore();
    const mockFiles: RepositoryFile[] = [
      {
        path: "src/valid.ts",
        type: "file",
        isAnalyzable: true,
        content: "export const hello = 'world';",
        sizeBytes: 30,
      },
      {
        path: "src/broken.ts",
        type: "file",
        isAnalyzable: true,
        content: "const a = ;;;; // corrupted syntax",
        sizeBytes: 35,
      },
      {
        path: "package.json",
        type: "file",
        isAnalyzable: true,
        content: JSON.stringify({ name: "test-app", dependencies: { next: "14.2.0" } }),
        sizeBytes: 50,
      },
      {
        path: "next.config.js",
        type: "file",
        isAnalyzable: true,
        content: "const nextConfig = { reactStrictMode: true }; module.exports = nextConfig;",
        sizeBytes: 70,
      },
    ];

    const mockProvider: RepositoryProvider = {
      getSnapshot: async () => {
        return ok({
          repository: {
            id: "test",
            owner: "testowner",
            name: "testrepo",
            url: "https://github.com/testowner/testrepo",
            defaultBranch: "main",
            selectedBranch: "main",
            sizeBytes: 115,
            fileCount: 3,
            commitSha: "abc1234567890123456789012345678901234567",
          },
          files: mockFiles,
          coverage: {
            filesConsidered: 3,
            filesSkipped: 0,
            filesSkippedByReason: { tooLarge: 0, unsupported: 0, limitReached: 0 },
            filesSkippedDetails: [],
            treeTruncated: false,
            analyzedPercent: 100,
            analysisConfidence: "high",
          },
        });
      },
    };

    const result = await runAnalysis(
      { owner: "testowner", name: "testrepo", url: "https://github.com/testowner/testrepo" },
      mockProvider,
      store,
      {
        parseSourceFile: (fileName: string) => {
          if (fileName.includes("broken.ts")) {
            throw new Error("Simulated fatal AST parse error in broken file");
          }
        },
      },
    );

    // Entire pipeline must succeed, not abort
    expect(result.ok).toBe(true);
    if (result.ok) {
      const analysis = result.value;
      expect(analysis.status).toBe("completed");

      // Coverage reflects the parse failure
      expect(analysis.coverage?.filesSkippedByReason?.parseFailure).toBe(1);
      const skippedDetails = analysis.coverage?.filesSkippedDetails?.find((f) => f.path === "src/broken.ts");
      expect(skippedDetails).toBeDefined();
      expect(skippedDetails?.reason).toBe("parse-failure");

      // Valid file was analyzed
      expect(analysis.filesAnalyzed).toBeGreaterThanOrEqual(1);
      expect(analysis.technologies.some((t) => t.technicalLabel === "Next.js")).toBe(true);
    }
  });
});
