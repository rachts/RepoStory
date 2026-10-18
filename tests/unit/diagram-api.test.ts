import { describe, expect, it } from "vitest";
import { PATCH, GET } from "@/app/api/diagrams/[diagramId]/route";
import { analysisStore } from "@/composition/container";
import type { Diagram } from "@/domain/diagram";

const apiDiagram: Diagram = {
  id: "api-diagram", analysisId: "api-analysis", type: "system-overview", title: "API diagram", description: "Original", direction: "TB",
  nodes: [{ id: "frontend", technicalLabel: "src/app", plainEnglishLabel: "Interface", explanation: "Shows the interface.", kind: "frontend", visible: true, confidence: "high", evidence: [{ id: "api-evidence", filePath: "src/app/page.tsx", reason: "Defines the interface." }] }],
  edges: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const context = { params: Promise.resolve({ diagramId: apiDiagram.id }) };

describe("diagram editing API", () => {
  it("patches and reads a diagram while preserving evidence", async () => {
    analysisStore.saveDiagram(apiDiagram);
    const response = await PATCH(new Request("http://localhost/api/diagrams/api-diagram", { method: "PATCH", body: JSON.stringify({ title: "Edited API diagram", nodeUpdates: [{ nodeId: "frontend", plainEnglishLabel: "The web interface" }] }), headers: { "content-type": "application/json" } }), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { diagram: Diagram };
    expect(payload.diagram.title).toBe("Edited API diagram");
    expect(payload.diagram.nodes[0]?.evidence[0]?.filePath).toBe("src/app/page.tsx");
    const readResponse = await GET(new Request("http://localhost/api/diagrams/api-diagram"), context);
    await expect(readResponse.json()).resolves.toMatchObject({ diagram: { title: "Edited API diagram" } });
  });

  it("rejects unknown elements and missing diagrams", async () => {
    const invalid = await PATCH(new Request("http://localhost/api/diagrams/api-diagram", { method: "PATCH", body: JSON.stringify({ nodeUpdates: [{ nodeId: "missing", visible: false }] }), headers: { "content-type": "application/json" } }), context);
    expect(invalid.status).toBe(400);
    const missing = await GET(new Request("http://localhost/api/diagrams/missing"), { params: Promise.resolve({ diagramId: "missing" }) });
    expect(missing.status).toBe(404);
  });

  it("rejects an empty patch instead of mutating the diagram timestamp", async () => {
    const response = await PATCH(new Request("http://localhost/api/diagrams/api-diagram", { method: "PATCH", body: JSON.stringify({}), headers: { "content-type": "application/json" } }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_PATCH", retryable: false } });
  });

  it("maps malformed JSON to the diagram patch contract", async () => {
    const response = await PATCH(new Request("http://localhost/api/diagrams/api-diagram", { method: "PATCH", body: "{", headers: { "content-type": "application/json" } }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_PATCH", retryable: false } });
  });
});
