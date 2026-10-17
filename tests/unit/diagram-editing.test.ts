import { describe, expect, it } from "vitest";
import { applyDiagramPatch } from "@/application/diagram-edits";
import { InMemoryAnalysisStore } from "@/application/store";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import type { Diagram } from "@/domain/diagram";

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
