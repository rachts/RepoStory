import { describe, expect, it } from "vitest";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";
import { GET as getDiagrams } from "@/app/api/analysis/[analysisId]/diagrams/route";
import { PATCH as patchDiagram } from "@/app/api/diagrams/[diagramId]/route";
import { analysisRepository, analysisStore, cacheStore } from "@/composition/container";
import { mergeDiagramEdits } from "@/application/diagram-edits";
import type { RepositoryProvider, RepositoryReference } from "@/domain/repository";
import type { Diagram } from "@/domain/diagram";
import { ok } from "@/shared/result";

describe("Fix 10: Cache-hit diagrams and user edits persistence", () => {
  it("merges user edits into base diagram while preserving untouched nodes and structure", () => {
    const base: Diagram = {
      id: "diagram-base",
      analysisId: "analysis-1",
      type: "system-overview",
      title: "System overview",
      description: "Default description",
      direction: "LR",
      nodes: [
        {
          id: "node-1",
          technicalLabel: "src/app",
          plainEnglishLabel: "Web App",
          explanation: "Frontend logic",
          kind: "frontend",
          visible: true,
          confidence: "high",
          evidence: [],
        },
        {
          id: "node-2",
          technicalLabel: "src/api",
          plainEnglishLabel: "Backend Server",
          explanation: "Backend logic",
          kind: "backend",
          visible: true,
          confidence: "high",
          evidence: [],
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          label: "requests",
          visible: true,
          confidence: "high",
          evidence: [],
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const edited: Diagram = {
      ...base,
      title: "Customized System Overview",
      nodes: [
        {
          ...base.nodes[0]!,
          plainEnglishLabel: "Customer Portal",
          visible: true,
        },
        {
          ...base.nodes[1]!,
          visible: false,
        },
      ],
      edges: [
        {
          ...base.edges[0]!,
          label: "secure-api-call",
        },
      ],
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    const merged = mergeDiagramEdits(base, edited);
    expect(merged.title).toBe("Customized System Overview");
    expect(merged.nodes[0]?.plainEnglishLabel).toBe("Customer Portal");
    expect(merged.nodes[0]?.technicalLabel).toBe("src/app");
    expect(merged.nodes[1]?.visible).toBe(false);
    expect(merged.edges[0]?.label).toBe("secure-api-call");
  });

  it("remaps diagrams, saves to store, and ensures /api/analysis/[id]/diagrams is not empty on cache hit", async () => {
    const store = new InMemoryAnalysisStore({ isScratch: true });
    const localCacheStore = new InMemoryCacheStore();
    const commitSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const ref: RepositoryReference = {
      owner: "test-owner",
      name: "test-repo",
      url: "https://github.com/test-owner/test-repo",
      branch: commitSha,
    };

    const mockProvider: RepositoryProvider = {
      getSnapshot: async () => {
        return ok({
          repository: {
            id: "repo-1",
            owner: ref.owner,
            name: ref.name,
            url: ref.url,
            defaultBranch: "main",
            selectedBranch: commitSha,
            commitSha,
            sizeBytes: 100,
            fileCount: 1,
          },
          files: [
            {
              path: "app/api/hello/route.ts",
              content: "export async function GET() { return Response.json({ ok: true }); }",
              sizeBytes: 65,
              type: "file",
              isAnalyzable: true,
            },
          ],
          coverage: {
            filesDiscovered: 1,
            filesAnalyzed: 1,
            filesSkippedByReason: { tooLarge: 0, unsupported: 0, limitReached: 0, parseFailure: 0, lfsPointer: 0, submodule: 0, unsupportedEncoding: 0, pathCollision: 0 },
          },
        });
      },
    };

    // First run: cold cache -> populates cacheStore
    const firstRun = await runAnalysis(ref, mockProvider, store, {
      cacheStore: localCacheStore,
      analysisId: "analysis-cold-run",
    });
    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) return;

    expect(firstRun.value.diagrams?.length).toBeGreaterThan(0);
    const originalDiagramIds = firstRun.value.diagrams!.map((d) => d.id);

    // Second run: should hit cache
    const secondStore = new InMemoryAnalysisStore({ isScratch: true });
    const secondRun = await runAnalysis(ref, mockProvider, secondStore, {
      cacheStore: localCacheStore,
      analysisId: "analysis-cached-run",
    });
    expect(secondRun.ok).toBe(true);
    if (!secondRun.ok) return;

    // Verify diagrams in second run are remapped to new analysisId and new unique IDs
    expect(secondRun.value.diagrams?.length).toBe(firstRun.value.diagrams?.length);
    for (const diagram of secondRun.value.diagrams!) {
      expect(diagram.analysisId).toBe("analysis-cached-run");
      expect(originalDiagramIds).not.toContain(diagram.id);
    }

    // Verify secondStore has the diagrams saved
    const savedInStore = secondStore.listDiagrams("analysis-cached-run");
    expect(savedInStore.length).toBe(secondRun.value.diagrams?.length);

    // Save to global analysisStore so API route can read it
    for (const diagram of secondRun.value.diagrams!) {
      analysisStore.saveDiagram(diagram);
    }
    analysisStore.save(secondRun.value);

    // Call GET /api/analysis/[analysisId]/diagrams
    const apiResponse = await getDiagrams(
      new Request("http://localhost/api/analysis/analysis-cached-run/diagrams"),
      { params: Promise.resolve({ analysisId: "analysis-cached-run" }) },
    );
    expect(apiResponse.status).toBe(200);
    const json = (await apiResponse.json()) as { diagrams: Diagram[] };
    expect(json.diagrams).toBeDefined();
    expect(json.diagrams.length).toBeGreaterThan(0);
  });

  it("merges user edits when analyzing the same commit after diagram patch", async () => {
    const localCacheStore = new InMemoryCacheStore();
    const commitSha = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";
    const ref: RepositoryReference = {
      owner: "custom-org",
      name: "custom-repo",
      url: "https://github.com/custom-org/custom-repo",
      branch: commitSha,
    };

    const mockProvider: RepositoryProvider = {
      getSnapshot: async () => {
        return ok({
          repository: {
            id: "repo-2",
            owner: ref.owner,
            name: ref.name,
            url: ref.url,
            defaultBranch: "main",
            selectedBranch: commitSha,
            commitSha,
            sizeBytes: 100,
            fileCount: 1,
          },
          files: [
            {
              path: "app/api/users/route.ts",
              content: "export async function GET() { return Response.json({ users: [] }); }",
              sizeBytes: 70,
              type: "file",
              isAnalyzable: true,
            },
          ],
          coverage: {
            filesDiscovered: 1,
            filesAnalyzed: 1,
            filesSkippedByReason: { tooLarge: 0, unsupported: 0, limitReached: 0, parseFailure: 0, lfsPointer: 0, submodule: 0, unsupportedEncoding: 0, pathCollision: 0 },
          },
        });
      },
    };

    // First analysis run
    const run1 = await runAnalysis(ref, mockProvider, analysisStore, {
      cacheStore: localCacheStore,
      analysisId: "analysis-user-edits-1",
    });
    expect(run1.ok).toBe(true);
    if (!run1.ok) return;

    const firstDiagram = run1.value.diagrams![0]!;
    expect(firstDiagram).toBeDefined();

    // User edits the first diagram:
    const editedTitle = "User Custom Architecture Title";
    const editsKey = `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}@${commitSha}:diagram-edits`;
    const editedDiagram: Diagram = {
      ...firstDiagram,
      title: editedTitle,
    };
    await localCacheStore.set(editsKey, { [firstDiagram.type]: editedDiagram });

    // Second analysis run on same commit (cache hit)
    const run2Store = new InMemoryAnalysisStore({ isScratch: true });
    const run2 = await runAnalysis(ref, mockProvider, run2Store, {
      cacheStore: localCacheStore,
      analysisId: "analysis-user-edits-2",
    });
    expect(run2.ok).toBe(true);
    if (!run2.ok) return;

    // Verify the cached diagram merged the user's edited title!
    const matchingDiagram = run2.value.diagrams?.find((d) => d.type === firstDiagram.type);
    expect(matchingDiagram).toBeDefined();
    expect(matchingDiagram?.title).toBe(editedTitle);
    expect(matchingDiagram?.analysisId).toBe("analysis-user-edits-2");
    expect(matchingDiagram?.id).not.toBe(firstDiagram.id);
  });
});
