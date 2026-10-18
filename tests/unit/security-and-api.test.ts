import { describe, expect, it } from "vitest";
import { POST as analyzePost } from "@/app/api/analyze/route";
import { redactPath, redactPathValues, redactSecrets } from "@/shared/redaction";
import { evidenceFor } from "@/analysis/evidence";
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

  it("redacts token-like path segments while preserving separators, ordinary names, and env examples", () => {
    expect(redactPath("sk-proj-example-secret/src/index.ts")).toBe("[REDACTED_OPENAI_KEY]/src/index.ts");
    expect(redactPath("src/ghp_example_secret/index.ts")).toBe("src/[REDACTED_GITHUB_TOKEN]/index.ts");
    expect(redactPath("src/xoxb-example-secret/config.ts")).toBe("src/[REDACTED_SLACK_TOKEN]/config.ts");
    expect(redactPath("src/app/api/projects/route.ts")).toBe("src/app/api/projects/route.ts");
    expect(redactPath(".env.example")).toBe(".env.example");
    expect(redactPath(".env.sample")).toBe(".env.sample");
    expect(redactPath(".env.template")).toBe(".env.template");
    expect(redactPath("src/api-key-prod-9fK2mP7qX4zN8vR1/index.ts")).toBe("src/[REDACTED_PATH_SEGMENT]/index.ts");
    expect(redactPath("src/4fB9kL2mQ8xN1pR7vT3yZ6wC9dH5/index.ts")).toBe("src/[REDACTED_PATH_SEGMENT]/index.ts");
    expect(redactPath("src/components/database/authentication/api/index.ts")).toBe("src/components/database/authentication/api/index.ts");
    expect(redactPath("src/feature-2026-release-notes-for-project/index.ts")).toBe("src/feature-2026-release-notes-for-project/index.ts");
  });

  it("redacts path fields in nested outward payloads without changing ordinary values", () => {
    const payload = redactPathValues({
      route: { filePath: "src/ghp_example_secret/index.ts", routePath: "/api/projects" },
      diagram: { technicalLabel: "src/xoxb-example-secret/config.ts", description: "ordinary description" },
      ordinary: "src/app/api/projects/route.ts",
    });
    expect(payload.route.filePath).toBe("src/[REDACTED_GITHUB_TOKEN]/index.ts");
    expect(payload.route.routePath).toBe("/api/projects");
    expect(payload.diagram.technicalLabel).toBe("src/[REDACTED_SLACK_TOKEN]/config.ts");
    expect(payload.diagram.description).toBe("ordinary description");
    expect(payload.ordinary).toBe("src/app/api/projects/route.ts");
  });

  it("redacts evidence paths at the analysis source boundary", () => {
    const evidence = evidenceFor({ path: "src/ghp_example_secret/index.ts", type: "file", sizeBytes: 1, content: "export const value = 1;", isAnalyzable: true }, "finds the entry point");
    expect(evidence.filePath).toBe("src/[REDACTED_GITHUB_TOKEN]/index.ts");
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
