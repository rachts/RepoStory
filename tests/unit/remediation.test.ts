import { describe, expect, it } from "vitest";
import { analyzeAuthentication } from "@/analysis/authentication";
import { analyzeDatabaseEvidence } from "@/analysis/database";
import { analyzeExternalIntegrations } from "@/analysis/integrations";
import { analyzeApiRoutes } from "@/analysis/routes";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import type { AnalysisJob } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";
import type { RepositoryFile } from "@/domain/repository";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { filterFiles } from "@/analysis/filter-files";
import { isSecretBearingPath, redactSecrets } from "@/shared/redaction";
import { ok } from "@/shared/result";

const limits = {
  maxFiles: 10,
  maxFileBytes: 100,
  maxTotalBytes: 1_000,
  maxContentBytes: 4,
  maxEvidenceExcerpt: 100,
  maxAnalysisMs: 1_000,
};

function sourceFile(path: string, content: string): RepositoryFile {
  return { path, type: "file", sizeBytes: content.length, content, isAnalyzable: true };
}

function diagramWithUntrustedText(): Diagram {
  return {
    id: "remediation-diagram",
    analysisId: "remediation-analysis",
    type: "repository-structure",
    title: "# injected heading",
    description: "<script>alert(1)</script>",
    direction: "TB",
    customNote: "> injected quote",
    nodes: [{ id: "node", technicalLabel: "`code`", plainEnglishLabel: "[malicious](https://example.com)", explanation: "<script>alert(1)</script>", kind: "file", visible: true, confidence: "high", evidence: [{ id: "evidence", filePath: "README.md", reason: "Evidence" }] }],
    edges: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Phase 3 remediation reproductions", () => {
  it("redacts nested secret files, quoted keys, and common token formats", () => {
    const secretText = [
      "{\"apiKey\":\"fake-secret\",\"token\":\"fake-token\"}",
      "STRIPE_SECRET_KEY=sk_live_fake",
      "OPENAI_API_KEY=sk-proj-fake",
      "Authorization: Bearer fake-bearer-token",
    ].join("\n");
    expect(isSecretBearingPath("config/.env.ts")).toBe(true);
    expect(filterFiles([sourceFile("config/.env.ts", secretText)])).toEqual([]);
    const redacted = redactSecrets(secretText);
    expect(redacted).not.toContain("fake-secret");
    expect(redacted).not.toContain("fake-token");
    expect(redacted).not.toContain("sk_live_fake");
    expect(redacted).not.toContain("sk-proj-fake");
    expect(redacted).not.toContain("fake-bearer-token");
  });

  it("redacts literal special-character values while keeping narrow dynamic references", () => {
    const redacted = redactSecrets([
      'PASSWORD="literal$secret"',
      'TOKEN="literal{secret}"',
      'CLIENT_SECRET="literal(secret)"',
      'PASSWORD="$literal"',
      'PASSWORD="${PASSWORD}"',
      "TOKEN=process.env.TOKEN",
      'DATABASE_URL=env("DATABASE_URL")',
    ].join("\n"));
    expect(redacted).not.toContain("literal$secret");
    expect(redacted).not.toContain("literal{secret}");
    expect(redacted).not.toContain("literal(secret)");
    expect(redacted).not.toContain("$literal");
    expect(redacted).toContain("${PASSWORD}");
    expect(redacted).toContain("process.env.TOKEN");
    expect(redacted).toContain('env("DATABASE_URL")');
  });

  it("redacts credentials from supported connection URL schemes and key names", () => {
    const urls = [
      "postgres://user:pass@example.com/app",
      "postgresql://user:pass@example.com/app",
      "mysql://user:pass@example.com/app",
      "mongodb://user:pass@example.com/app",
      "mongodb+srv://user:pass@example.com/app",
      "redis://:pass@example.com/0",
      "rediss://:pass@example.com/0",
      "amqp://user:pass@example.com/vhost",
      "amqps://user:pass@example.com/vhost",
      "mssql://user:pass@example.com/app",
      "sqlserver://user:pass@example.com/app",
      "jdbc:postgresql://user:pass@example.com/app",
    ];
    for (const url of urls) {
      const redacted = redactSecrets(`CONNECTION_STRING=${url}`);
      expect(redacted).not.toContain("user:pass");
      expect(redacted).not.toContain(":pass@");
      expect(redacted).toContain("[REDACTED_CONNECTION_STRING]");
    }
    expect(redactSecrets("DATABASE_URI=literal(secret)")).not.toContain("literal(secret)");
    expect(redactSecrets("MONGO_URI=literal(secret)")).not.toContain("literal(secret)");
    expect(redactSecrets("REDIS_URL=literal{secret}")).not.toContain("literal{secret}");
    expect(redactSecrets("JDBC_URL=literal$secret")).not.toContain("literal$secret");
  });

  it("keeps secret-bearing content out of pipeline findings and diagram exports", async () => {
    const secret = "OPENAI_API_KEY=sk-proj-pipeline-secret";
    const provider = { getSnapshot: async () => ok({ repository: { id: "secret-repo", owner: "fixture", name: "secret-repo", url: "https://github.com/fixture/secret-repo", defaultBranch: "main", selectedBranch: "main", sizeBytes: 30, fileCount: 2 }, files: [sourceFile("src/config/.env.ts", secret), sourceFile("src/page.tsx", "export default function Page() { return null; }")] }) };
    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name: "secret-repo", url: "https://github.com/fixture/secret-repo" }, provider, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("sk-proj-pipeline-secret");
    expect(result.value.diagramIds.length).toBeGreaterThan(0);
    for (const diagramId of result.value.diagramIds) {
      const diagram = store.getDiagram(diagramId);
      expect(diagram).toBeDefined();
      expect(toMermaid(diagram!)).not.toContain("sk-proj-pipeline-secret");
      expect(toMarkdown(diagram!)).not.toContain("sk-proj-pipeline-secret");
    }
  });

  it("does not infer integrations, databases, or auth from generic calls", () => {
    const files = [
      sourceFile("src/client.ts", "export const client = new Client();\nexport const db = createClient();"),
      sourceFile("middleware.ts", "export function middleware() { return redirect(\"/login\"); }"),
    ];
    expect(analyzeExternalIntegrations(files)).toEqual([]);
    expect(analyzeDatabaseEvidence(files)).toEqual([]);
    expect(analyzeAuthentication(files)).toEqual([]);
  });

  it("rejects an Express-looking file when the receiver is not a router", () => {
    const findings = analyzeApiRoutes([sourceFile("src/client.ts", "import express from \"express\";\nconst client = axios;\nclient.get(\"/remote\");")]);
    expect(findings).toEqual([]);
  });

  it("sanitizes secret-looking route paths in route findings and pipeline diagrams", async () => {
    const secret = "sk-proj-route-secret";
    const provider = { getSnapshot: async () => ok({
      repository: { id: "route-secret-repo", owner: "fixture", name: "route-secret-repo", url: "https://github.com/fixture/route-secret-repo", defaultBranch: "main", selectedBranch: "main", sizeBytes: 200, fileCount: 1 },
      files: [sourceFile("src/server.ts", `import express from "express";\nconst app = express();\napp.get("/api/${secret}", () => null);`)],
    }) };
    const directFindings = analyzeApiRoutes([sourceFile("src/server.ts", `import express from "express";\nconst app = express();\napp.get("/api/${secret}", () => null);`)]);
    expect(directFindings).toHaveLength(1);
    expect(JSON.stringify(directFindings)).not.toContain(secret);

    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name: "route-secret-repo", url: "https://github.com/fixture/route-secret-repo" }, provider, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apiRoutes).toHaveLength(1);
    expect(JSON.stringify(result.value.apiRoutes)).not.toContain(secret);
    for (const diagramId of result.value.diagramIds) {
      const diagram = store.getDiagram(diagramId);
      expect(diagram).toBeDefined();
      expect(toMermaid(diagram!)).not.toContain(secret);
      expect(toMarkdown(diagram!)).not.toContain(secret);
    }
  });

  it("accepts a branch name containing slashes", () => {
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature/api-cleanup")).toMatchObject({ ok: true, value: { branch: "feature/api-cleanup" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature%2Fapi-cleanup")).toMatchObject({ ok: true, value: { branch: "feature/api-cleanup" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/")).toMatchObject({ ok: true, value: { name: "widget" } });
    expect(parseGitHubUrl("https://github.com/acme/widget.git")).toMatchObject({ ok: true, value: { name: "widget" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature/../secret")).toMatchObject({ ok: false, error: { code: "INVALID_URL" } });
  });

  it("keeps untrusted Markdown text from changing document structure", () => {
    const markdown = toMarkdown(diagramWithUntrustedText());
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toMatch(/^# injected heading$/m);
    expect(markdown).not.toMatch(/^> injected quote$/m);
    expect(markdown).not.toMatch(/\[malicious\]\(https:\/\/example\.com\)/);
    expect(markdown).not.toMatch(/`code`/);
  });

  it("gives repeated analyses of one repository different IDs", async () => {
    const store = new InMemoryAnalysisStore();
    const provider = new FixtureRepositoryProvider();
    const reference = { owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" };
    const [first, second] = await Promise.all([runAnalysis(reference, provider, store), runAnalysis(reference, provider, store)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.id).not.toBe(first.value.id);
      expect(second.value.diagramIds[0]).not.toBe(first.value.diagramIds[0]);
      expect(store.getDiagram(first.value.diagramIds[0]!)?.analysisId).toBe(first.value.id);
      expect(store.getDiagram(second.value.diagramIds[0]!)?.analysisId).toBe(second.value.id);
    }
  });

  it("expires analyses and evicts the oldest entry at capacity", () => {
    let now = 0;
    const store = new InMemoryAnalysisStore({ maxAnalyses: 1, ttlMs: 100, now: () => now });
    const job = (id: string): AnalysisJob => ({ id, repository: { id, owner: "fixture", name: id, url: `https://github.com/fixture/${id}`, defaultBranch: "main", selectedBranch: "main", sizeBytes: 0, fileCount: 0 }, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered: 0, filesAnalyzed: 0, technologies: [], findings: [], diagramIds: [], createdAt: new Date(0).toISOString() });
    store.save(job("analysis-a"));
    store.saveDiagram({ ...diagramWithUntrustedText(), id: "diagram-a", analysisId: "analysis-a" });
    store.save(job("analysis-b"));
    store.saveDiagram({ ...diagramWithUntrustedText(), id: "diagram-b", analysisId: "analysis-b" });
    expect(store.get("analysis-a")).toBeUndefined();
    expect(store.getDiagram("diagram-a")).toBeUndefined();
    expect(store.get("analysis-b")).toBeDefined();
    now = 101;
    expect(store.get("analysis-b")).toBeUndefined();
    expect(store.getDiagram("diagram-b")).toBeUndefined();
  });

  it("returns a structured timeout when the full pipeline deadline is exceeded", async () => {
    let clock = 0;
    const result = await runAnalysis({ owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" }, new FixtureRepositoryProvider(), new InMemoryAnalysisStore(), {
      now: () => { clock += 100; return clock; },
      limits: { ...limits, maxAnalysisMs: 50 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ANALYSIS_TIMEOUT");
  });

  it("rejects unsafe tree paths before fetching content", async () => {
    const calls: string[] = [];
    const provider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      if (url.includes("/git/trees/main")) return new Response(JSON.stringify({ tree: [{ path: "../secret.ts", type: "blob", size: 1 }] }));
      return new Response(JSON.stringify({ content: "c2VjcmV0", encoding: "base64" }));
    } });
    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(result.ok).toBe(false);
    expect(calls.some((url) => url.includes("/contents/"))).toBe(false);
  });

  it.each(["/absolute/path.ts", "foo\\bar.ts", "foo/./bar.ts", "foo/../bar.ts"])("rejects unsafe tree path %s", async (path) => {
    const provider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      return new Response(JSON.stringify({ tree: [{ path, type: "blob", size: 1 }] }));
    } });
    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(result.ok).toBe(false);
  });

  it("rejects truncated trees and content that exceeds the configured limit", async () => {
    const truncatedProvider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      return new Response(JSON.stringify({ truncated: true, tree: [] }));
    } });
    const truncated = await truncatedProvider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(truncated.ok).toBe(false);

    const oversizedProvider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      if (url.includes("/git/trees/main")) return new Response(JSON.stringify({ tree: [{ path: "src/a.ts", type: "blob", size: 4 }] }));
      return new Response(JSON.stringify({ content: "c2VjcmV0", encoding: "base64" }));
    } });
    const oversized = await oversizedProvider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(oversized.ok).toBe(false);
  });

  it("rejects oversized tree responses and invalid base64 content", async () => {
    const responseLimits = { ...limits, maxResponseBytes: 500 };
    const oversizedTreeProvider = new GitHubPublicRepositoryProvider({ limits: responseLimits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      return new Response(JSON.stringify({ tree: [], padding: "x".repeat(2_000) }));
    } });
    const oversizedTree = await oversizedTreeProvider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(oversizedTree.ok).toBe(false);

    const invalidBase64Provider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      if (url.includes("/git/trees/main")) return new Response(JSON.stringify({ tree: [{ path: "src/a.ts", type: "blob", size: 1 }] }));
      return new Response(JSON.stringify({ content: "not-base64", encoding: "base64" }));
    } });
    const invalidBase64 = await invalidBase64Provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(invalidBase64.ok).toBe(false);
  });
});
