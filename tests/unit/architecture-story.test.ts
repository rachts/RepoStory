import { describe, expect, it } from "vitest";
import { generateArchitectureStory } from "@/analysis/architecture-story";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { EvidenceReference } from "@/domain/evidence";
import { InMemoryAnalysisStore } from "@/application/store";
import { runAnalysis } from "@/application/pipeline";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import { analysisStore } from "@/composition/container";
import { GET as getAnalysis } from "@/app/api/analysis/[analysisId]/route";

function evidence(id: string, filePath = "src/app.ts"): EvidenceReference {
  return { id, filePath, lineStart: 1, lineEnd: 1, reason: `Evidence ${id}` };
}

function node(partial: Partial<DiagramNode> & Pick<DiagramNode, "id" | "kind">): DiagramNode {
  return {
    id: partial.id,
    kind: partial.kind,
    technicalLabel: partial.technicalLabel ?? partial.id,
    plainEnglishLabel: partial.plainEnglishLabel ?? partial.id,
    explanation: partial.explanation ?? `Evidence-backed ${partial.id}.`,
    visible: partial.visible ?? true,
    confidence: partial.confidence ?? "high",
    evidence: partial.evidence ?? [evidence(`${partial.id}-evidence`)],
  };
}

function edge(partial: Partial<DiagramEdge> & Pick<DiagramEdge, "id" | "source" | "target">): DiagramEdge {
  return {
    id: partial.id,
    source: partial.source,
    target: partial.target,
    label: partial.label ?? "connects",
    explanation: partial.explanation ?? "The static diagram connects these elements.",
    visible: partial.visible ?? true,
    ...(partial.inferred !== undefined ? { inferred: partial.inferred } : {}),
    confidence: partial.confidence ?? "high",
    evidence: partial.evidence ?? [evidence(`${partial.id}-evidence`)],
  };
}

function diagram(nodes: DiagramNode[], edges: DiagramEdge[]): Diagram {
  return {
    id: "diagram-test",
    analysisId: "analysis-test",
    type: "api-request-flow",
    title: "API request flow",
    description: "Test flow",
    direction: "LR",
    nodes,
    edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("deterministic architecture story", () => {
  it("integrates a plain-English, evidence-backed story into the analysis pipeline", async () => {
    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name: "next-api", url: "https://github.com/fixture/next-api" }, new FixtureRepositoryProvider(), store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const story = result.value.architectureStory;
    expect(story).toBeDefined();
    if (!story) return;
    expect(story.summary).toBe(story.plainEnglishSummary);
    expect(story.actors.some((actor) => actor.kind === "person" && actor.evidence.length > 0)).toBe(true);
    expect(story.steps.some((step) => step.kind === "api")).toBe(true);
    expect(story.layers.map((layer) => layer.plainEnglishLabel)).toContain("Request handling");
    expect(story.relationships.every((relationship) => relationship.evidence.length > 0)).toBe(true);
    expect(story.steps.some((step) => step.kind === "database")).toBe(false);
    expect(story.layers.some((layer) => layer.kind === "external-service")).toBe(false);
    expect(story.coverage.apiRequestFlowAvailable).toBe(true);
    expect(story.coverage.filesSkipped).toBe(story.coverage.filesDiscovered - story.coverage.filesAnalyzed);
    expect(story.coverage.bytesAnalyzed).toBeGreaterThan(0);
    expect(story.coverage.bytesDiscovered).toBeGreaterThanOrEqual(story.coverage.bytesAnalyzed ?? 0);
  });

  it("returns the generated story through the existing analysis response", async () => {
    const result = await runAnalysis({ owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" }, new FixtureRepositoryProvider(), analysisStore);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const response = await getAnalysis(new Request(`http://localhost/api/analysis/${result.value.id}`), { params: Promise.resolve({ analysisId: result.value.id }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ architectureStory: { summary: expect.any(String), coverage: { status: expect.any(String) } } });
  });

  it("keeps story IDs, element ordering, and output stable across repeated analyses", async () => {
    const first = await runAnalysis({ owner: "fixture", name: "next-api", url: "https://github.com/fixture/next-api" }, new FixtureRepositoryProvider(), new InMemoryAnalysisStore());
    const second = await runAnalysis({ owner: "fixture", name: "next-api", url: "https://github.com/fixture/next-api" }, new FixtureRepositoryProvider(), new InMemoryAnalysisStore());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.architectureStory).toEqual(second.value.architectureStory);
    const story = first.value.architectureStory!;
    const layerOrder = new Map(story.layers.map((layer) => [layer.id, layer.order]));
    expect(story.steps.map((step) => step.order)).toEqual(story.steps.map((_step, index) => index + 1));
    expect(story.steps).toEqual([...story.steps].sort((left, right) => {
      const leftLayer = layerOrder.get(left.layerId) ?? 0;
      const rightLayer = layerOrder.get(right.layerId) ?? 0;
      return leftLayer - rightLayer || left.technicalLabel.localeCompare(right.technicalLabel) || left.id.localeCompare(right.id);
    }));
  });

  it("propagates evidence and confidence while marking inferred and unconfirmed relationships", () => {
    const story = generateArchitectureStory({
      repository: { id: "fixture-story", name: "fixture-story" },
      findings: [],
      diagrams: [diagram([
        node({ id: "unconfirmed-service", kind: "service", technicalLabel: "Unknown service", plainEnglishLabel: "Unknown service", evidence: [] }),
        node({ id: "user", kind: "person", technicalLabel: "Client", plainEnglishLabel: "Person or client", confidence: "medium", evidence: [evidence("user-proof")] }),
        node({ id: "app", kind: "backend", technicalLabel: "fixture-story", plainEnglishLabel: "Application", confidence: "high", evidence: [evidence("app-proof")] }),
        node({ id: "route", kind: "api", technicalLabel: "GET /api/items", plainEnglishLabel: "Get items", confidence: "low", evidence: [evidence("route-proof")] }),
      ], [
        edge({ id: "user-app", source: "user", target: "app", label: "uses", confidence: "medium", evidence: [evidence("user-app-proof")] }),
        edge({ id: "app-route", source: "app", target: "route", label: "may evaluate", confidence: "needs-verification", evidence: [evidence("app-route-proof")] }),
        edge({ id: "unsupported", source: "route", target: "unconfirmed-service", label: "calls", evidence: [] }),
      ])],
      diagramAvailability: [
        { type: "repository-structure", available: false },
        { type: "system-overview", available: false, reason: "No technology evidence." },
        { type: "api-request-flow", available: true, confidence: "low" },
        { type: "authentication-flow", available: false, reason: "No authentication evidence." },
      ],
    });

    expect(story.actors.map((actor) => actor.plainEnglishLabel)).toEqual(["Person or client", "Application"]);
    expect(story.actors.find((actor) => actor.plainEnglishLabel === "Application")).toMatchObject({ kind: "backend", label: "fixture-story" });
    expect(story.steps.map((step) => step.plainEnglishLabel)).toContain("Get items");
    expect(story.steps.map((step) => step.plainEnglishLabel)).not.toContain("Unknown service");
    expect(story.relationships.map((relationship) => relationship.label)).toEqual(["Inferred: uses", "Needs verification: may evaluate"]);
    expect(story.relationships.find((relationship) => relationship.label === "Needs verification: may evaluate")).toMatchObject({ verification: "needs-verification", inferred: true, confidence: "needs-verification", evidence: [evidence("app-route-proof")] });
    expect(story.coverage.status).toBe("partial");
    expect(story.coverage.partial).toBe(true);
    expect(story.caveats).toEqual(expect.arrayContaining([
      "System overview is unavailable: No technology evidence.",
      "Authentication flow is unavailable: No authentication evidence.",
      "Some architecture elements have low or needs-verification confidence; confirm them against the cited evidence.",
    ]));
  });

  it("returns an honest empty story without inventing actors, data stores, or services", () => {
    const story = generateArchitectureStory({
      repository: { id: "empty", name: "empty" },
      findings: [],
      diagrams: [],
      filesAnalyzed: 0,
      filesDiscovered: 2,
    });

    expect(story.actors).toEqual([]);
    expect(story.steps).toEqual([]);
    expect(story.layers).toEqual([]);
    expect(story.relationships).toEqual([]);
    expect(story.coverage.status).toBe("empty");
    expect(story.coverage.partial).toBe(true);
    expect(story.summary.toLowerCase()).not.toContain("database");
    expect(story.summary.toLowerCase()).not.toContain("external service");
    expect(story.caveats).toEqual(expect.arrayContaining([
      "Only 0 of 2 discovered files were analyzed, so this story has partial repository coverage.",
      "No evidence-backed actors, steps, layers, or relationships were found.",
    ]));
  });

  it("preserves inferred edge markers and evidence for non-narrative layers", () => {
    const story = generateArchitectureStory({
      repository: { id: "inferred-edge", name: "inferred-edge" },
      findings: [],
      diagrams: [diagram([
        node({ id: "user", kind: "person", technicalLabel: "Client", plainEnglishLabel: "Person", confidence: "high" }),
        node({ id: "app", kind: "backend", technicalLabel: "Application", plainEnglishLabel: "Application", confidence: "high" }),
        node({ id: "module", kind: "file", technicalLabel: "src/service.ts", plainEnglishLabel: "Service module", confidence: "high" }),
      ], [
        edge({ id: "user-app-inferred", source: "user", target: "app", label: "uses", confidence: "high", inferred: true }),
      ])],
    });

    expect(story.relationships).toEqual([expect.objectContaining({ label: "Inferred: uses", verification: "inferred", inferred: true, confidence: "high" })]);
    expect(story.layers.find((layer) => layer.kind === "module")).toMatchObject({ nodeIds: ["module"], evidence: [evidence("module-evidence")] });
  });
});
