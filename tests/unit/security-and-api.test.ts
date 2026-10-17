import { describe, expect, it } from "vitest";
import { POST as analyzePost } from "@/app/api/analyze/route";
import { redactSecrets } from "@/shared/redaction";
import { filterFiles } from "@/analysis/filter-files";
import { toMermaid } from "@/analysis/exports";
import type { Diagram } from "@/domain/diagram";

describe("security and API boundaries", () => {
  it("redacts token, password, connection string, and private key values", () => {
    const secretText = [
      "token=ghp_1234567890abcdef",
      "password=super-secret",
      "DATABASE_URL=postgres://user:password@example.com/app",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(secretText);
    expect(redacted).not.toContain("ghp_1234567890abcdef");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("user:password@example.com");
    expect(redacted).not.toContain("BEGIN PRIVATE KEY");
  });

  it("excludes secret-bearing and generated paths", () => {
    const files = filterFiles([
      { path: ".env", type: "file", sizeBytes: 10, content: "TOKEN=secret", isAnalyzable: true },
      { path: ".env.example", type: "file", sizeBytes: 10, content: "TOKEN=example", isAnalyzable: true },
      { path: "node_modules/pkg/index.js", type: "file", sizeBytes: 10, content: "module", isAnalyzable: true },
      { path: "src/page.tsx", type: "file", sizeBytes: 10, content: "export default 1", isAnalyzable: true },
    ]);
    expect(files.map((file) => file.path)).toEqual([".env.example", "src/page.tsx"]);
  });

  it("returns a structured validation error for malformed analyze requests", async () => {
    const response = await analyzePost(new Request("http://localhost/api/analyze", { method: "POST", body: JSON.stringify({ repositoryUrl: "http://example.com/repo" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNSUPPORTED_HOST", retryable: false } });
  });

  it("escapes Mermaid labels and keeps the requested direction", () => {
    const diagram: Diagram = {
      id: "diagram-special", analysisId: "analysis-special", type: "repository-structure", title: "Special", description: "Special", direction: "LR",
      nodes: [{ id: "a", technicalLabel: "A", plainEnglishLabel: "Quotes [and] {braces}", explanation: "", kind: "file", visible: true, confidence: "high", evidence: [] }],
      edges: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const source = toMermaid(diagram);
    expect(source).toContain("flowchart LR");
    expect(source).not.toContain("[and]");
  });
});
