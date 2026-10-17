import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import { InMemoryAnalysisStore } from "@/application/store";
import { runAnalysis } from "@/application/pipeline";
import { toMermaid, toMarkdown } from "@/analysis/exports";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";

describe("RepoStory Phase 1 core", () => {
  it("strictly parses public GitHub repository URLs", () => {
    expect(parseGitHubUrl("https://github.com/acme/widget/tree/main")).toMatchObject({ ok: true, value: { owner: "acme", name: "widget", branch: "main" } });
    expect(parseGitHubUrl("http://github.com/acme/widget")).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_HOST" } });
    expect(parseGitHubUrl("https://github.com/acme/widget/issues")).toMatchObject({ ok: false, error: { code: "INVALID_URL" } });
  });

  it("runs a deterministic fixture analysis with evidence and exports", async () => {
    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react" }, new FixtureRepositoryProvider(), store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.technologies.map((finding) => finding.technicalLabel)).toEqual(["Node.js / React", "TypeScript"]);
    expect(result.value.findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    const diagram = store.getDiagram(result.value.diagramIds[0]!);
    expect(diagram).toBeDefined();
    expect(toMermaid(diagram!)).toContain("flowchart TB");
    expect(toMarkdown(diagram!, { includeEvidence: true })).toContain("Evidence:");
  });

  it("normalizes mocked GitHub metadata and fetches only analyzable files", async () => {
    const calls: string[] = [];
    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ id: 42, default_branch: "main", size: 1, html_url: "https://github.com/acme/widget" }), { status: 200 });
        if (url.includes("/git/trees/main")) return new Response(JSON.stringify({ tree: [{ path: "README.md", type: "blob", size: 20 }, { path: "node_modules/pkg/index.js", type: "blob", size: 20 }] }), { status: 200 });
        return new Response(JSON.stringify({ content: Buffer.from("# Widget").toString("base64"), encoding: "base64" }), { status: 200 });
      },
    });
    const result = await provider.getSnapshot({ owner: "acme", name: "widget", url: "https://github.com/acme/widget" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repository.id).toBe("42");
    expect(result.value.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(calls.some((url) => url.includes("node_modules"))).toBe(false);
  });

  it("runs the Phase 3 detectors and stores API-flow diagrams through the pipeline", async () => {
    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name: "next-api", url: "https://github.com/fixture/next-api" }, new FixtureRepositoryProvider(), store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apiRoutes?.length).toBeGreaterThan(0);
    expect(result.value.moduleRelationships?.length).toBeGreaterThan(0);
    expect(result.value.diagramIds.map((id) => store.getDiagram(id)?.type)).toContain("api-request-flow");
    expect(result.value.diagramAvailability?.find((item) => item.type === "api-request-flow")?.available).toBe(true);
  });

  it.each([
    ["next-api", "apiRoutes"],
    ["express-api", "apiRoutes"],
    ["authenticated-app", "authentication"],
    ["database-app", "databases"],
    ["external-integrations", "externalIntegrations"],
    ["ambiguous-routes", "apiRoutes"],
  ] as const)("analyzes the Phase 3 fixture %s through the full pipeline", async (name, collection) => {
    const store = new InMemoryAnalysisStore();
    const result = await runAnalysis({ owner: "fixture", name, url: `https://github.com/fixture/${name}` }, new FixtureRepositoryProvider(), store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesAnalyzed).toBeGreaterThan(0);
    expect(result.value.findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    expect(result.value[collection]?.length).toBeGreaterThan(0);
    expect(result.value.diagramAvailability).toHaveLength(4);
  });
});
