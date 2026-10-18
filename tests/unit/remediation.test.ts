import { describe, expect, it, vi } from "vitest";
import { analyzeAuthentication } from "@/analysis/authentication";
import { analyzeDatabaseEvidence } from "@/analysis/database";
import { analyzeExternalIntegrations } from "@/analysis/integrations";
import { analyzeApiRoutes } from "@/analysis/routes";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import { apiRequestFlowDiagram } from "@/analysis/flow-diagrams";
import { importCandidates } from "@/analysis/module-relationships";
import { sourceFiles } from "@/analysis/static-utils";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import { GET as getAnalysis } from "@/app/api/analysis/[analysisId]/route";
import { GET as getAnalysisDiagrams } from "@/app/api/analysis/[analysisId]/diagrams/route";
import { GET as getDiagram } from "@/app/api/diagrams/[diagramId]/route";
import { analysisStore } from "@/composition/container";
import type { AnalysisJob } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";
import type { RepositoryFile } from "@/domain/repository";
import { AppError } from "@/domain/errors";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { filterFiles } from "@/analysis/filter-files";
import { analyzeTechnologies } from "@/analysis/technology";
import { analyzeEntryPoints } from "@/analysis/entry-point";
import { analyzeDirectories } from "@/analysis/directory";
import { isSecretBearingPath, redactSecrets } from "@/shared/redaction";
import { redactPath } from "@/shared/redaction";
import { truncate } from "@/shared/text";
import { ok } from "@/shared/result";
import { createAnalysisBudget, DEFAULT_LIMITS, type AnalysisBudget } from "@/shared/limits";

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

  it("sorts before applying the file-count cap so ignored or later files do not starve analysis", () => {
    const selected = filterFiles([
      sourceFile("z.ts", "export const z = 1;"),
      sourceFile("node_modules/ignored.ts", "export const ignored = 1;"),
      sourceFile("a.ts", "export const a = 1;"),
      sourceFile("b.ts", "export const b = 1;"),
    ], { ...limits, maxFiles: 2 });

    expect(selected.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("uses UTF-8 byte sizes and rejects malformed file metadata", () => {
    const unicode = filterFiles([{ path: "src/unicode.ts", type: "file", content: "😀😀", isAnalyzable: true }], { ...limits, maxFileBytes: 7 });
    expect(unicode).toEqual([]);

    const malformed = filterFiles([{ path: "src/malformed.ts", type: "file", sizeBytes: -1, content: "ok", isAnalyzable: true }], limits);
    expect(malformed).toEqual([]);

    const normalized = filterFiles([{ path: "src\\normalized.ts", type: "file", content: "ok", isAnalyzable: true }], limits);
    expect(normalized[0]?.path).toBe("src/normalized.ts");

    expect(filterFiles([{ path: "src/../secret.ts", type: "file", content: "ok", isAnalyzable: true }])).toEqual([]);
    expect(filterFiles([{ path: "src", type: "directory", isAnalyzable: true }])).toEqual([]);
    expect(filterFiles([{ path: "Dockerfile", type: "file", content: "FROM node:22", isAnalyzable: true }])).toHaveLength(1);
  });

  it("does not claim technologies or entry points from directories or filename-only matches", () => {
    const files: RepositoryFile[] = [
      { path: "package.json", type: "file", content: '{"dependencies":{"lodash":"1.0.0"}}', isAnalyzable: true },
      { path: "src/page.tsx", type: "file", content: "export const notAReactComponent = true;", isAnalyzable: true },
      { path: "src/page.tsx", type: "directory", content: "", isAnalyzable: true },
      { path: "src\\index.ts", type: "file", content: "export const value = 1;", isAnalyzable: true },
    ];

    expect(analyzeTechnologies(files).map((finding) => finding.technicalLabel)).toEqual([]);
    expect(analyzeEntryPoints(files).map((finding) => finding.technicalLabel)).toEqual(["package.json", "src/index.ts", "src/page.tsx"]);
    expect(analyzeDirectories(files).map((finding) => finding.technicalLabel)).toEqual(["src"]);
  });

  it("fails closed for invalid analysis budget durations", () => {
    const budget = createAnalysisBudget(-1, () => 0);
    expect(() => budget.check()).not.toThrow();

    const immediate = createAnalysisBudget(0, () => 0);
    expect(() => immediate.check()).toThrowError(expect.objectContaining({ code: "ANALYSIS_TIMEOUT" }));
  });

  it("handles zero, fractional, and unbounded text limits predictably", () => {
    expect(truncate("secret", 0)).toBe("");
    expect(truncate("abcdef", 3.9)).toBe("ab…");
    expect(truncate("secret", Number.POSITIVE_INFINITY)).toBe("secret");
    expect(truncate("secret", Number.NaN)).toBe("");
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

  it.each([
    ["import { router } from unrelated package", `import { router } from "unrelated-package";\nrouter.get("/not-express", handler);`],
    ["require unrelated router", `const apiRouter = require("unrelated-package");\napiRouter.use("/not-express", handler);`],
    ["bare Router call", `const router = Router();\nrouter.get("/not-express", handler);`],
  ])("rejects Express-looking code without proven Express provenance: %s", (_label, content) => {
    expect(analyzeApiRoutes([sourceFile("src/server.ts", content)])).toEqual([]);
  });

  it("accepts Express routers proven by imports and require provenance", () => {
    const findings = analyzeApiRoutes([sourceFile("src/server.ts", [
      'import express, { Router as ImportedRouter } from "express";',
      "const app = express();",
      "const router = ImportedRouter();",
      'app.use("/api", router);',
      'router.get("/health", handler);',
      'const expressRouter = require("express").Router();',
      'expressRouter.post("/users", handler);',
    ].join("\n"))]);
    expect(findings.map((finding) => `${finding.methods[0]} ${finding.routePath}`)).toEqual(expect.arrayContaining(["GET /api/health", "POST /users"]));
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

  it("keeps secret-looking route paths out of the analysis API response", async () => {
    const secret = "sk-proj-api-response-secret";
    const provider = { getSnapshot: async () => ok({
      repository: { id: "api-route-secret-repo", owner: "fixture", name: "api-route-secret-repo", url: "https://github.com/fixture/api-route-secret-repo", defaultBranch: "main", selectedBranch: "main", description: "description sk-proj-description-secret", sizeBytes: 200, fileCount: 1 },
      files: [sourceFile("src/server.ts", `import express from "express";\nconst app = express();\napp.get("/api/${secret}", () => null);`)],
    }) };
    const result = await runAnalysis({ owner: "fixture", name: "api-route-secret-repo", url: "https://github.com/fixture/api-route-secret-repo" }, provider, analysisStore);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const response = await getAnalysis(new Request("http://localhost/api/analysis"), { params: Promise.resolve({ analysisId: result.value.id }) });
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).not.toContain("sk-proj-description-secret");
  });

  it("keeps token-like path components out of findings, stored diagrams, APIs, and exports", async () => {
    const rawPaths = [
      "sk-proj-example-secret/src/index.ts",
      "src/ghp_example_secret/index.ts",
      "src/xoxb-example-secret/config.ts",
    ];
    expect(redactPath(rawPaths[0]!)).toBe("[REDACTED_OPENAI_KEY]/src/index.ts");
    expect(redactPath(rawPaths[1]!)).toBe("src/[REDACTED_GITHUB_TOKEN]/index.ts");
    expect(redactPath(rawPaths[2]!)).toBe("src/[REDACTED_SLACK_TOKEN]/config.ts");
    const isolatedStore = new InMemoryAnalysisStore();
    isolatedStore.saveDiagram({ ...diagramWithUntrustedText(), id: "path-boundary-diagram", analysisId: "path-boundary-analysis", nodes: [{ ...diagramWithUntrustedText().nodes[0]!, technicalLabel: rawPaths[0]! }] });
    expect(JSON.stringify(isolatedStore.getDiagram("path-boundary-diagram"))).not.toContain(rawPaths[0]!);

    const provider = {
      getSnapshot: async () => ok({
        repository: { id: "path-boundary-repo", owner: "fixture", name: "path-boundary-repo", url: "https://github.com/fixture/path-boundary-repo", defaultBranch: "main", selectedBranch: "main", sizeBytes: 500, fileCount: 4 },
        files: [
          sourceFile(rawPaths[0]!, "export const index = 1;"),
          sourceFile(rawPaths[1]!, "export const index = 2;"),
          sourceFile(rawPaths[2]!, 'import { WebClient } from "@slack/web-api";\nconst client = new WebClient();'),
          sourceFile("src/app/api/projects/route.ts", "export async function GET() { return new Response(\"ok\"); }"),
        ],
      }),
    };
    const result = await runAnalysis({ owner: "fixture", name: "path-boundary-repo", url: "https://github.com/fixture/path-boundary-repo" }, provider, analysisStore);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rawJob = JSON.stringify(result.value);
    expect(rawPaths.every((path) => !rawJob.includes(path))).toBe(true);
    expect(rawJob).toContain("src/app/api/projects/route.ts");

    const analysisResponse = await getAnalysis(new Request("http://localhost/api/analysis"), { params: Promise.resolve({ analysisId: result.value.id }) });
    const analysisPayload = await analysisResponse.json();
    const diagramsResponse = await getAnalysisDiagrams(new Request("http://localhost/api/analysis/diagrams"), { params: Promise.resolve({ analysisId: result.value.id }) });
    const diagramsPayload = await diagramsResponse.json();
    expect(analysisResponse.status).toBe(200);
    expect(diagramsResponse.status).toBe(200);
    expect(rawPaths.every((path) => !JSON.stringify(analysisPayload).includes(path))).toBe(true);
    expect(rawPaths.every((path) => !JSON.stringify(diagramsPayload).includes(path))).toBe(true);

    for (const diagramId of result.value.diagramIds) {
      const stored = analysisStore.getDiagram(diagramId);
      expect(stored).toBeDefined();
      expect(rawPaths.every((path) => !JSON.stringify(stored).includes(path))).toBe(true);
      const diagramResponse = await getDiagram(new Request(`http://localhost/api/diagrams/${diagramId}`), { params: Promise.resolve({ diagramId }) });
      const diagramPayload = await diagramResponse.json();
      expect(diagramResponse.status).toBe(200);
      expect(rawPaths.every((path) => !JSON.stringify(diagramPayload).includes(path))).toBe(true);
      expect(rawPaths.every((path) => !toMermaid(stored!).includes(path))).toBe(true);
      expect(rawPaths.every((path) => !toMarkdown(stored!).includes(path))).toBe(true);
    }
  });

  it("accepts a branch name containing slashes", () => {
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature/api-cleanup")).toMatchObject({ ok: true, value: { branch: "feature/api-cleanup" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature%2Fapi-cleanup")).toMatchObject({ ok: true, value: { branch: "feature/api-cleanup" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/")).toMatchObject({ ok: true, value: { name: "widget" } });
    expect(parseGitHubUrl("https://github.com/acme/widget.git")).toMatchObject({ ok: true, value: { name: "widget" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/feature/../secret")).toMatchObject({ ok: false, error: { code: "INVALID_URL" } });
  });

  it.each(["feature:bad", "feature~bad", "feature/.hidden", "feature/release.lock", "feature/@{bad}"])("rejects invalid Git ref branch component %s", (branch) => {
    expect(parseGitHubUrl(`https://github.com/acme/widget/tree/${encodeURIComponent(branch)}`)).toMatchObject({ ok: false, error: { code: "INVALID_URL" } });
  });

  it("keeps untrusted Markdown text from changing document structure", () => {
    const markdown = toMarkdown(diagramWithUntrustedText());
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toMatch(/^# injected heading$/m);
    expect(markdown).not.toMatch(/^> injected quote$/m);
    expect(markdown).not.toMatch(/\[malicious\]\(https:\/\/example\.com\)/);
    expect(markdown).not.toMatch(/`code`/);
  });

  it("sanitizes Mermaid node identifiers independently from visible labels", () => {
    const unsafe = diagramWithUntrustedText();
    const mermaid = toMermaid({
      ...unsafe,
      nodes: [{ ...unsafe.nodes[0]!, id: "node id\nwith\\escape" }],
      edges: [{ id: "edge id", source: "node id\nwith\\escape", target: "node id\nwith\\escape", label: "self", visible: true, confidence: "high", evidence: [] }],
    });

    expect(mermaid).not.toContain("node id\nwith\\escape");
    expect(mermaid).toMatch(/flowchart TB\n  node_id_with_escape\["/);
    expect(mermaid).not.toContain("\\escape");
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

  it("does not resurrect an analysis after capacity eviction", () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 1, ttlMs: 10_000 });
    const job = (id: string): AnalysisJob => ({ id, repository: { id, owner: "fixture", name: id, url: `https://github.com/fixture/${id}`, defaultBranch: "main", selectedBranch: "main", sizeBytes: 0, fileCount: 0 }, status: "running", stage: "fetching-metadata", progressPercent: 10, filesDiscovered: 0, filesAnalyzed: 0, technologies: [], findings: [], diagramIds: [], createdAt: new Date(0).toISOString() });
    store.startAnalysis?.("analysis-a");
    store.save(job("analysis-a"));
    store.save(job("analysis-b"));
    store.saveDiagram({ ...diagramWithUntrustedText(), id: "diagram-a-after-eviction", analysisId: "analysis-a" });
    store.save(job("analysis-a"));
    store.finishAnalysis?.("analysis-a");

    expect(store.get("analysis-a")).toBeUndefined();
    expect(store.getDiagram("diagram-a-after-eviction")).toBeUndefined();
    expect(store.get("analysis-b")).toBeDefined();
  });

  it("returns a structured timeout when the full pipeline deadline is exceeded", async () => {
    let clock = 0;
    const store = new InMemoryAnalysisStore();
    const save = vi.spyOn(store, "save");
    const result = await runAnalysis({ owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" }, new FixtureRepositoryProvider(), store, {
      now: () => { clock += 100; return clock; },
      limits: { ...limits, maxAnalysisMs: 50 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ANALYSIS_TIMEOUT");
    expect(save.mock.calls.map(([job]) => job.status)).not.toContain("completed");
    expect(save.mock.calls.at(-1)?.[0].status).toBe("failed");
  });

  it("expires during import discovery before candidate processing completes", () => {
    const content = Array.from({ length: 100 }, (_, index) => `import module${index} from \"./module-${index}\";`).join("\n");
    let checks = 0;
    const budget: AnalysisBudget = {
      check: () => {
        checks += 1;
        if (checks > 2) throw new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true });
      },
    };

    expect(() => importCandidates(content, budget)).toThrowError(expect.objectContaining({ code: "ANALYSIS_TIMEOUT" }));
    expect(checks).toBeGreaterThan(2);
  });

  it("rejects an oversized GitHub tree before collecting entries for sorting", async () => {
    const calls: string[] = [];
    const provider = new GitHubPublicRepositoryProvider({
      limits: { ...limits, maxTreeEntries: 2 },
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
        return new Response(JSON.stringify({ tree: [
          { path: "src/b.ts", type: "blob", size: 1 },
          { path: "src/a.ts", type: "blob", size: 1 },
          { path: "src/c.ts", type: "blob", size: 1 },
        ] }));
      },
    });

    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REPOSITORY_TOO_LARGE");
    expect(calls.some((url) => url.includes("/contents/"))).toBe(false);
  });

  it("caps source-file sorting and checks the budget around the sort", () => {
    const files = Array.from({ length: DEFAULT_LIMITS.maxFiles + 25 }, (_, index) => sourceFile(`src/${String(DEFAULT_LIMITS.maxFiles + 25 - index).padStart(5, "0")}.ts`, ""));
    let checks = 0;
    const budget: AnalysisBudget = { check: () => { checks += 1; } };
    const result = sourceFiles(files, budget);

    expect(result).toHaveLength(DEFAULT_LIMITS.maxFiles);
    expect(result[0]?.path).toBe("src/00001.ts");
    expect(result.at(-1)?.path).toBe("src/02000.ts");
    expect(result.map((file) => file.path)).toEqual([...result].sort((left, right) => left.path.localeCompare(right.path)).map((file) => file.path));
    expect(checks).toBeGreaterThan(DEFAULT_LIMITS.maxFiles + 1);
  });

  it("returns a structured timeout while assembling streamed GitHub response chunks", async () => {
    let streaming = false;
    let streamedChecks = 0;
    const budget: AnalysisBudget = {
      check: () => {
        if (!streaming) return;
        streamedChecks += 1;
        if (streamedChecks > 4) throw new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true });
      },
    };
    const provider = new GitHubPublicRepositoryProvider({
      limits,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
        streaming = true;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"tree":'));
            controller.enqueue(encoder.encode("[]}"));
            controller.close();
          },
        }));
      },
    });

    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" }, undefined, budget);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ANALYSIS_TIMEOUT");
    expect(streamedChecks).toBeGreaterThan(4);
  });

  it("does not save a completed job when a budget expires after partial diagram work", async () => {
    let expired = false;
    const budget: AnalysisBudget = {
      check: () => {
        if (expired) throw new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true });
      },
    };
    const store = new InMemoryAnalysisStore();
    const save = vi.spyOn(store, "save");
    const persistDiagram = store.saveDiagram.bind(store);
    const saveDiagram = vi.spyOn(store, "saveDiagram").mockImplementation((diagram) => {
      persistDiagram(diagram);
      expired = true;
    });
    const provider = new FixtureRepositoryProvider();
    const result = await runAnalysis({ owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" }, provider, store, {
      budget,
      limits: { ...limits, maxAnalysisMs: 60_000 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ANALYSIS_TIMEOUT");
    expect(saveDiagram).toHaveBeenCalled();
    expect(save.mock.calls.map(([job]) => job.status)).not.toContain("completed");
  });

  it("checks the analysis budget during flow-node generation", () => {
    let checks = 0;
    const budget = {
      check: () => {
        checks += 1;
        if (checks > 2) throw new Error("budget exhausted");
      },
    };
    const manyRoutes = Array.from({ length: 20 }, (_, index) => ({
      id: `route-${index}`,
      kind: "api-route" as const,
      technicalLabel: `GET /route-${index}`,
      plainEnglishLabel: `GET /route-${index}`,
      explanation: "Route evidence",
      confidence: "high" as const,
      evidence: [{ id: `evidence-${index}`, filePath: `src/routes/${index}.ts`, reason: "Route evidence" }],
      routePath: `/route-${index}`,
      path: `/route-${index}`,
      route: `/route-${index}`,
      methods: ["GET" as const],
      httpMethods: ["GET" as const],
      framework: "express" as const,
      filePath: `src/routes/${index}.ts`,
    }));
    expect(() => {
      apiRequestFlowDiagram("budget-analysis", { id: "repo", owner: "fixture", name: "budget", url: "https://github.com/fixture/budget", defaultBranch: "main", selectedBranch: "main", sizeBytes: 0, fileCount: 20 }, manyRoutes, [], budget);
    }).toThrow("budget exhausted");
    expect(checks).toBeGreaterThan(2);
  });

  it("returns a structured timeout when the GitHub provider loop budget expires", async () => {
    let checks = 0;
    const budget = {
      check: () => {
        checks += 1;
        if (checks > 3) throw new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true });
      },
    };
    const provider = new GitHubPublicRepositoryProvider({ limits, fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }));
      return new Response(JSON.stringify({ tree: Array.from({ length: 20 }, (_, index) => ({ path: `src/${index}.ts`, type: "blob", size: 1 })) }));
    } });
    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" }, undefined, budget);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ANALYSIS_TIMEOUT");
    expect(checks).toBeGreaterThan(3);
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
    expect(oversized.ok).toBe(true);
    if (oversized.ok) expect(oversized.value.files).toHaveLength(0);
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

  it("disables upstream redirects and caches while keeping repository URLs canonical", async () => {
    const requests: RequestInit[] = [];
    const provider = new GitHubPublicRepositoryProvider({ fetchImpl: async (input, init) => {
      requests.push(init ?? {});
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 1, default_branch: "main", html_url: "https://evil.example/redirect" }));
      return new Response(JSON.stringify({ tree: [] }));
    } });

    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repository.url).toBe("https://github.com/acme/widget");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.redirect === "error" && request.cache === "no-store")).toBe(true);
  });
});
