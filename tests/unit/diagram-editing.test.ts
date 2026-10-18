import { describe, expect, it } from "vitest";
import { applyDiagramPatch } from "@/application/diagram-edits";
import { InMemoryAnalysisStore } from "@/application/store";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import type { Diagram } from "@/domain/diagram";
import type { ArchitectureStory } from "@/domain/architecture-story";

const diagram: Diagram = {
  id: "diagram-edit", analysisId: "analysis-edit", type: "repository-structure", title: "Original", description: "Original description", direction: "TB", customNote: "Original note",
  nodes: [{ id: "repo", technicalLabel: "repo", plainEnglishLabel: "Repository", explanation: "Original explanation", kind: "directory", visible: true, confidence: "high", evidence: [{ id: "evidence-1", filePath: "README.md", lineStart: 1, reason: "Identifies the repository." }] }],
  edges: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("diagram editing", () => {
  it("patches presentation fields while preserving evidence and redacting secrets", () => {
    const updated = applyDiagramPatch(diagram, { title: "Edited", direction: "LR", customNote: "token=secret", nodeUpdates: [{ nodeId: "repo", plainEnglishLabel: "The codebase", visible: false }] });
    expect(updated.title).toBe("Edited");
    expect(updated.direction).toBe("LR");
    expect(updated.customNote).not.toContain("secret");
    expect(updated.nodes[0]?.visible).toBe(false);
    expect(updated.nodes[0]?.evidence).toEqual(diagram.nodes[0]?.evidence);
    expect(toMermaid(updated)).not.toContain("repo");
  });

  it("redacts token-like paths in edited diagram labels", () => {
    const updated = applyDiagramPatch(diagram, { nodeUpdates: [{ nodeId: "repo", technicalLabel: "src/xoxb-example-secret/config.ts" }] });
    expect(updated.nodes[0]?.technicalLabel).toBe("src/[REDACTED_SLACK_TOKEN]/config.ts");
    expect(JSON.stringify(updated)).not.toContain("xoxb-example-secret");
  });

  it("redacts the exact secret-looking path while preserving an ordinary route path", () => {
    const updated = applyDiagramPatch(diagram, { nodeUpdates: [{ nodeId: "repo", technicalLabel: "sk-proj-example-secret/src/index.ts", explanation: "src/app/api/projects/route.ts" }] });
    expect(updated.nodes[0]?.technicalLabel).toBe("[REDACTED_OPENAI_KEY]/src/index.ts");
    expect(updated.nodes[0]?.explanation).toBe("src/app/api/projects/route.ts");
    expect(JSON.stringify(updated)).not.toContain("sk-proj-example-secret");
  });

  it("keeps hidden edges out of Mermaid and includes edited Markdown content", () => {
    const withEdge: Diagram = { ...diagram, title: "Edited title", description: "Edited description", edges: [{ id: "edge-1", source: "repo", target: "repo", label: "hidden edge", visible: false, confidence: "medium", evidence: [] }] };
    const markdown = toMarkdown(withEdge, { includeEvidence: true });
    expect(markdown).toContain("# Edited title");
    expect(markdown).toContain("Edited description");
    expect(markdown).not.toContain("hidden edge");
  });

  it("exports detailed escaped evidence while excluding hidden and secret content", () => {
    const withEvidence: Diagram = {
      ...diagram,
      nodes: [
        {
          ...diagram.nodes[0]!,
          evidence: [{
            id: "detailed-evidence",
            filePath: "src/[api]*.ts",
            lineStart: 10,
            lineEnd: 14,
            symbol: "handle(request)",
            reason: "Routes [safe] requests.",
            excerpt: "const token = sk-proj-export-secret; // [keep]",
          }],
        },
        {
          ...diagram.nodes[0]!,
          id: "hidden-node",
          visible: false,
          evidence: [{ id: "hidden-evidence", filePath: "src/hidden.ts", reason: "sk-proj-hidden-secret" }],
        },
      ],
    };

    const markdown = toMarkdown(withEvidence, { includeEvidence: true });

    expect(markdown).toContain("path: src/\\[api\\]\\*\\.ts");
    expect(markdown).toContain("lines: 10\\-14");
    expect(markdown).toContain("symbol: handle\\(request\\)");
    expect(markdown).toContain("reason: Routes \\[safe\\] requests\\.");
    expect(markdown).toContain("excerpt: const token = \\[REDACTED\\_OPENAI\\_KEY\\]");
    expect(markdown).not.toContain("sk-proj-hidden-secret");
    expect(markdown).not.toContain("sk-proj-export-secret");
    expect(markdown).toContain("REDACTED\\_OPENAI\\_KEY");
  });

  it("omits edges connected to hidden nodes and exports confidence notes", () => {
    const withHiddenTarget: Diagram = {
      ...diagram,
      nodes: [
        ...diagram.nodes,
        { id: "hidden", technicalLabel: "hidden", plainEnglishLabel: "Hidden module", explanation: "Hidden module", kind: "file", visible: false, confidence: "low", evidence: [] },
      ],
      edges: [{ id: "edge-hidden-target", source: "repo", target: "hidden", label: "uses", visible: true, confidence: "low", evidence: [] }],
    };
    expect(toMermaid(withHiddenTarget)).not.toContain("edge-hidden-target");
    expect(toMermaid(withHiddenTarget)).not.toContain("uses");
    expect(toMarkdown(withHiddenTarget)).toContain("confidence: high");
  });

  it("optionally exports the plain-English architecture story before Mermaid", () => {
    const storyEvidence = [{ id: "story-visible", filePath: "src/app/page.tsx", lineStart: 1, reason: "Shows the visible interface." }];
    const hiddenEvidence = [{ id: "story-hidden", filePath: "src/hidden.ts", lineStart: 2, reason: "Hidden service evidence." }];
    const story: ArchitectureStory = {
      id: "story-export",
      headline: "How the application works",
      summary: "The application appears to show a web interface.",
      plainEnglishSummary: "The application appears to show a web interface.",
      confidence: "medium",
      evidence: [...storyEvidence, ...hiddenEvidence],
      actors: [
        { id: "visible-actor", kind: "frontend", label: "Frontend", technicalLabel: "React frontend", plainEnglishLabel: "Web interface", explanation: "The visible interface.", inferred: false, confidence: "high", evidence: storyEvidence, sourceNodeIds: ["repo"], sourceDiagramTypes: ["system-overview"] },
        { id: "hidden-actor", kind: "external-service", label: "Hidden", technicalLabel: "Hidden service", plainEnglishLabel: "Hidden service", explanation: "Should not export.", inferred: false, confidence: "high", evidence: hiddenEvidence, sourceNodeIds: ["hidden"], sourceDiagramTypes: ["system-overview"] },
      ],
      steps: [{ id: "visible-step", kind: "application", order: 1, layerId: "layer", title: "The interface is shown", plainEnglishTitle: "The interface is shown", technicalLabel: "render", plainEnglishLabel: "The interface is shown", explanation: "The visible step.", confidence: "high", evidence: storyEvidence, sourceNodeIds: ["repo"], targetNodeIds: [], sourceDiagramTypes: ["system-overview"] }, { id: "hidden-step", kind: "external-service", order: 2, layerId: "layer", title: "Hidden service", plainEnglishTitle: "Hidden service", technicalLabel: "secretCall", plainEnglishLabel: "Hidden service", explanation: "Should not export.", confidence: "high", evidence: hiddenEvidence, sourceNodeIds: ["hidden"], targetNodeIds: [], sourceDiagramTypes: ["system-overview"] }],
      layers: [{ id: "layer", kind: "application", order: 1, label: "application", technicalLabel: "application", plainEnglishLabel: "Application", purpose: "Application layer.", explanation: "Application layer.", nodeIds: ["repo"], actorIds: ["visible-actor"], stepIds: ["visible-step"], relationshipIds: [], confidence: "high", evidence: storyEvidence, sourceDiagramTypes: ["system-overview"] }],
      relationships: [],
      coverage: { status: "partial", partial: true, filesAnalyzed: 1, filesDiscovered: 2, analyzedFiles: 1, discoveredFiles: 2, evidenceBackedFindings: 1, evidenceBackedElements: 2, availableDiagramTypes: ["system-overview"], unavailableDiagramTypes: [], diagramAvailability: [], repositoryStructureAvailable: true, systemOverviewAvailable: true, apiRequestFlowAvailable: false, authenticationFlowAvailable: false, caveats: ["Partial coverage."] },
      caveats: ["Partial coverage."],
    };
    const withHiddenNode: Diagram = { ...diagram, nodes: [...diagram.nodes, { id: "hidden", technicalLabel: "hidden", plainEnglishLabel: "Hidden service", explanation: "Hidden", kind: "service", visible: false, confidence: "high", evidence: hiddenEvidence }] };
    const enabled = toMarkdown(withHiddenNode, { includeArchitectureSummary: true, includeEvidence: true, architectureStory: story });
    const disabled = toMarkdown(withHiddenNode, { includeArchitectureSummary: false, includeEvidence: true, architectureStory: story });
    expect(enabled.indexOf("## How the application works")).toBeLessThan(enabled.indexOf("```mermaid"));
    expect(enabled).toContain("The application appears to show a web interface\\.");
    expect(enabled).toContain("Evidence: path: src/app/page\\.tsx");
    expect(enabled).not.toContain("Hidden service");
    expect(enabled).not.toContain("src/hidden.ts");
    expect(disabled).not.toContain("## How the application works");
  });

  it("restores the generated diagram without losing its evidence", () => {
    const store = new InMemoryAnalysisStore();
    store.saveDiagram(diagram);
    store.saveDiagram(applyDiagramPatch(diagram, { title: "Edited", nodeUpdates: [{ nodeId: "repo", visible: false }] }));
    const reset = store.resetDiagram(diagram.id);
    expect(reset?.title).toBe("Original");
    expect(reset?.nodes[0]?.visible).toBe(true);
    expect(reset?.nodes[0]?.evidence).toEqual(diagram.nodes[0]?.evidence);
  });
});
