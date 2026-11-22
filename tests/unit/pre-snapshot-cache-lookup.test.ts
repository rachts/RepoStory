import { describe, it, expect, vi } from "vitest";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";
import type { RepositoryProvider, RepositorySnapshot } from "@/domain/repository";
import type { AnalysisResult } from "@/domain/analysis";
import { ok } from "@/shared/result";

describe("Fix 9: Pre-snapshot cache check with lightweight ref lookup", () => {
  const commitSha = "e8b2a1c0d4f567890123456789abcdef01234567";
  const cachedAnalysis: AnalysisResult = {
    id: "cached-analysis-id",
    repository: {
      id: "repo-1",
      owner: "acme",
      name: "widget",
      url: "https://github.com/acme/widget",
      defaultBranch: "main",
      selectedBranch: "main",
      commitSha,
      sizeBytes: 1000,
      fileCount: 10,
    },
    technologies: [{ id: "t1", technicalLabel: "TypeScript", plainEnglishLabel: "TypeScript", explanation: "TypeScript language", kind: "technology", confidence: "high", evidence: [] }],
    findings: [],
    diagramIds: ["diag-1"],
    progressPercent: 100,
    filesDiscovered: 10,
    filesAnalyzed: 10,
    coverage: {
      filesConsidered: 10,
      filesSkipped: 0,
      filesSkippedByReason: { tooLarge: 0, unsupported: 0, limitReached: 0, lfsPointer: 0, submodule: 0, unsupportedEncoding: 0, pathCollision: 0 },
      treeTruncated: false,
      analysisConfidence: "high",
    },
    diagrams: [
      {
        id: "diag-1",
        analysisId: "cached-analysis-id",
        type: "system-overview",
        title: "System Overview",
        description: "Overview diagram",
        direction: "LR",
        nodes: [{ id: "n1", technicalLabel: "App", plainEnglishLabel: "App", explanation: "Main app", kind: "service", visible: true, confidence: "high", evidence: [] }],
        edges: [],
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
      },
    ],
    status: "completed",
    stage: "completed",
    createdAt: "2026-11-20T00:00:00.000Z",
    completedAt: "2026-11-20T00:01:00.000Z",
  };

  it("resolves commit SHA via lightweight lookup and hits cache with ZERO getSnapshot calls", async () => {
    const cacheStore = new InMemoryCacheStore();
    const cacheKey = "acme/widget@" + commitSha + ":analysis";
    await cacheStore.set(cacheKey, cachedAnalysis);

    const mockResolveCommitSha = vi.fn().mockResolvedValue(ok(commitSha));
    const mockGetSnapshot = vi.fn();

    const mockProvider: RepositoryProvider = {
      cacheStore,
      resolveCommitSha: mockResolveCommitSha,
      getSnapshot: mockGetSnapshot,
    };

    const store = new InMemoryAnalysisStore();

    const result = await runAnalysis(
      { owner: "acme", name: "widget", branch: "main", url: "https://github.com/acme/widget" },
      mockProvider,
      store,
      { analysisId: "new-analysis-123", cacheStore },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1. Ref lookup was called
    expect(mockResolveCommitSha).toHaveBeenCalledTimes(1);

    // 2. getSnapshot was NEVER called (zero tree, zero archive, zero metadata calls)
    expect(mockGetSnapshot).not.toHaveBeenCalled();

    // 3. Returned job has new analysis ID and remapped diagrams
    expect(result.value.id).toBe("new-analysis-123");
    expect(result.value.status).toBe("completed");
    expect(result.value.diagrams).toBeDefined();
    expect(result.value.diagrams!).toHaveLength(1);
    expect(result.value.diagrams![0]?.analysisId).toBe("new-analysis-123");
    expect(result.value.diagrams![0]?.id).toBe("diag-1");
  });

  it("falls through to getSnapshot when commit SHA is resolved but not in cache", async () => {
    const cacheStore = new InMemoryCacheStore();
    const mockResolveCommitSha = vi.fn().mockResolvedValue(ok("ffffffffffffffffffffffffffffffffffffffff"));
    const mockGetSnapshot = vi.fn().mockResolvedValue(
      ok<RepositorySnapshot>({
        repository: cachedAnalysis.repository,
        files: [],
        coverage: { filesConsidered: 0, filesSkipped: 0 },
      }),
    );

    const mockProvider: RepositoryProvider = {
      cacheStore,
      resolveCommitSha: mockResolveCommitSha,
      getSnapshot: mockGetSnapshot,
    };

    const store = new InMemoryAnalysisStore();

    const result = await runAnalysis(
      { owner: "acme", name: "widget", branch: "main", url: "https://github.com/acme/widget" },
      mockProvider,
      store,
      { analysisId: "new-analysis-456", cacheStore },
    );

    expect(result.ok).toBe(true);
    expect(mockResolveCommitSha).toHaveBeenCalledTimes(1);
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
  });
});
