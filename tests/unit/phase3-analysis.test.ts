import { describe, expect, it } from "vitest";
import type { RepositoryFile, Repository } from "@/domain/repository";
import { analyzeApiRoutes } from "@/analysis/routes";
import { analyzeModuleRelationships, importCandidates } from "@/analysis/module-relationships";
import { moduleAliases, resolveLocalModule } from "@/analysis/static-utils";
import { analyzeDatabaseEvidence } from "@/analysis/database";
import { analyzeExternalIntegrations } from "@/analysis/integrations";
import { analyzeAuthentication } from "@/analysis/authentication";
import { analyzeDirectories } from "@/analysis/directory";
import { analyzePhase3 } from "@/analysis/phase3";
import { apiRequestFlowDiagram, authenticationFlowDiagram } from "@/analysis/flow-diagrams";
import { systemOverviewDiagram } from "@/analysis/diagrams";
import { analyzeTechnologies } from "@/analysis/technology";
import nextApiFixture from "../../fixtures/repositories/next-api/repository.json";
import expressFixture from "../../fixtures/repositories/express-api/repository.json";
import authenticatedFixture from "../../fixtures/repositories/authenticated-app/repository.json";
import databaseFixture from "../../fixtures/repositories/database-app/repository.json";
import integrationsFixture from "../../fixtures/repositories/external-integrations/repository.json";
import ambiguousFixture from "../../fixtures/repositories/ambiguous-routes/repository.json";

function files(fixture: { files: unknown[] }): RepositoryFile[] {
  return fixture.files as RepositoryFile[];
}

function repository(fixture: { repository: unknown }): Repository {
  return fixture.repository as Repository;
}

describe("RepoStory Phase 3 deterministic analysis", () => {
  it("detects Next.js App Router and Pages Router API methods", () => {
    const findings = analyzeApiRoutes(files(nextApiFixture));
    expect(findings.map((finding) => [finding.framework, finding.routePath, finding.methods])).toEqual(expect.arrayContaining([
      ["next-app-router", "/api/users", ["GET", "POST"]],
      ["next-app-router", "/api/users/[id]", ["DELETE"]],
      ["next-pages-router", "/api/legacy", ["GET", "POST"]],
    ]));
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.evidence.length > 0 && finding.explanation.length > 0)).toBe(true);
  });

  it("anchors evidence to the actual exported handler when the first method is declared later", () => {
    const findings = analyzeApiRoutes([{
      path: "src/app/api/later/route.ts",
      type: "file",
      content: "const note = true;\nexport const POST = async () => Response.json({ ok: true });\n",
      isAnalyzable: true,
    }]);

    expect(findings[0]?.methods).toEqual(["POST"]);
    expect(findings[0]?.evidence[0]?.lineStart).toBe(2);
  });

  it("detects Express routes and mounted prefixes", () => {
    const findings = analyzeApiRoutes(files(expressFixture));
    expect(findings.map((finding) => `${finding.methods[0]} ${finding.routePath}`)).toEqual(expect.arrayContaining([
      "DELETE /api/admin/:id",
      "GET /api/users",
      "POST /api/users",
      "GET /health",
    ]));
    expect(findings).toHaveLength(4);
    expect(findings.find((finding) => finding.routePath === "/api/admin/:id")?.prefix).toBe("/api/admin");
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it("resolves mounted prefixes for Express app variables with nonstandard names", () => {
    const findings = analyzeApiRoutes([{
      path: "src/server.ts",
      type: "file",
      content: [
        'import express from "express";',
        'const server = express();',
        'const api = express.Router();',
        'server.use("/v1", api);',
        'api.get("/health", handler);',
      ].join("\n"),
      isAnalyzable: true,
    }]);

    expect(findings).toEqual([expect.objectContaining({ routePath: "/v1/health", prefix: "/v1" })]);
  });

  it("resolves local static imports without executing repository code", () => {
    const relationships = analyzeModuleRelationships(files(nextApiFixture));
    expect(relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "src/app/api/users/service.ts", targetFile: "src/lib/users.ts", importType: "static", relationship: "imports" }),
    ]));
    expect(relationships.every((relationship) => relationship.evidence.length > 0 && relationship.plainEnglishLabel.length > 0)).toBe(true);
  });

  it("prefers specific path aliases and resolves published JavaScript specifiers to TypeScript sources", () => {
    const aliasFiles: RepositoryFile[] = [
      { path: "tsconfig.json", type: "file", content: JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"], "@feature/*": ["packages/feature/*"] } } }), isAnalyzable: true },
      { path: "src/index.ts", type: "file", content: 'import { feature } from "@feature/thing";\nimport { local } from "./local.js";', isAnalyzable: true },
      { path: "src/local.ts", type: "file", content: "export const local = true;", isAnalyzable: true },
      { path: "src/feature/thing.ts", type: "file", content: "export const feature = false;", isAnalyzable: true },
      { path: "packages/feature/thing.ts", type: "file", content: "export const feature = true;", isAnalyzable: true },
    ];

    expect(importCandidates(aliasFiles[1]!.content!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ specifier: "@feature/thing" }),
      expect.objectContaining({ specifier: "./local.js" }),
    ]));
    const aliases = moduleAliases(aliasFiles);
    expect(resolveLocalModule("src/index.ts", "./local.js", new Set(aliasFiles.map((file) => file.path)), aliases)).toMatchObject({ targetPath: "src/local.ts" });
    const relationships = analyzeModuleRelationships(aliasFiles);
    expect(relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "src/index.ts", targetFile: "packages/feature/thing.ts", specifier: "@feature/thing" }),
      expect.objectContaining({ sourceFile: "src/index.ts", targetFile: "src/local.ts", specifier: "./local.js" }),
    ]));
    expect(relationships).not.toEqual(expect.arrayContaining([expect.objectContaining({ targetFile: "src/feature/thing.ts", specifier: "@feature/thing" })]));
  });

  it("collects database evidence from dependencies, clients, schemas, and migrations", () => {
    const findings = analyzeDatabaseEvidence(files(databaseFixture));
    expect(findings.map((finding) => finding.technology)).toEqual(expect.arrayContaining(["Drizzle ORM", "PostgreSQL client", "Prisma", "SQL migrations"]));
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it("detects named external services from imports and initialization", () => {
    const findings = analyzeExternalIntegrations(files(integrationsFixture));
    expect(findings.map((finding) => finding.service)).toEqual(expect.arrayContaining(["External HTTP API", "OpenAI", "Sentry", "SendGrid", "Stripe"]));
    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.evidence.length > 0 && finding.plainEnglishLabel.length > 0)).toBe(true);
  });

  it("redacts token-like file paths while preserving an ordinary API route path", () => {
    const tokenFiles: RepositoryFile[] = [
      { path: "sk-proj-example-secret/src/index.ts", type: "file", sizeBytes: 20, content: "export const index = 1;", isAnalyzable: true },
      { path: "src/ghp_example_secret/index.ts", type: "file", sizeBytes: 20, content: "export const index = 1;", isAnalyzable: true },
      { path: "src/xoxb-example-secret/config.ts", type: "file", sizeBytes: 120, content: 'import { WebClient } from "@slack/web-api";\nconst client = new WebClient();', isAnalyzable: true },
      { path: "src/app/api/projects/route.ts", type: "file", sizeBytes: 80, content: "export async function GET() { return new Response(\"ok\"); }", isAnalyzable: true },
    ];

    const directories = analyzeDirectories(tokenFiles);
    const routes = analyzeApiRoutes(tokenFiles);
    const integrations = analyzeExternalIntegrations(tokenFiles);

    expect(directories.find((finding) => finding.technicalLabel === "[REDACTED_OPENAI_KEY]")?.technicalLabel).toBe("[REDACTED_OPENAI_KEY]");
    expect(routes).toEqual([expect.objectContaining({ routePath: "/api/projects", filePath: "src/app/api/projects/route.ts", handler: "src/app/api/projects/route.ts" })]);
    expect(JSON.stringify(integrations)).not.toContain("xoxb-example-secret");
    expect(JSON.stringify([...directories, ...routes, ...integrations])).not.toContain("sk-proj-example-secret");
    expect(JSON.stringify([...directories, ...routes, ...integrations])).not.toContain("ghp_example_secret");
  });

  it("detects authentication providers, JWT evidence, and middleware", () => {
    const findings = analyzeAuthentication(files(authenticatedFixture));
    expect(findings.map((finding) => finding.provider)).toEqual(["Application middleware", "Auth.js / NextAuth", "JWT"]);
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it("does not infer active integrations, databases, or auth from package declarations alone", () => {
    const packageOnly: RepositoryFile[] = [{
      path: "package.json",
      type: "file",
      sizeBytes: 180,
      content: JSON.stringify({ dependencies: { stripe: "1.0.0", prisma: "1.0.0", "@prisma/client": "1.0.0", "next-auth": "1.0.0", openai: "1.0.0" } }),
      isAnalyzable: true,
    }];
    expect(analyzeExternalIntegrations(packageOnly)).toEqual([]);
    expect(analyzeDatabaseEvidence(packageOnly)).toEqual([]);
    expect(analyzeAuthentication(packageOnly)).toEqual([]);
  });

  it("marks route methods for verification when the filename is stronger than the code evidence", () => {
    const findings = analyzeApiRoutes(files(ambiguousFixture));
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.methods.length > 0)).toBe(true);
    expect(findings.every((finding) => finding.methods[0] === "UNKNOWN" && finding.confidence === "needs-verification")).toBe(true);
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it("generates request and authentication diagrams only when supporting evidence exists", () => {
    const phase3 = analyzePhase3(files(authenticatedFixture));
    const requestDiagram = apiRequestFlowDiagram("analysis-auth", repository(authenticatedFixture), phase3.findings, phase3.moduleRelationships);
    const authDiagram = authenticationFlowDiagram("analysis-auth", repository(authenticatedFixture), phase3.findings, phase3.moduleRelationships);
    expect(requestDiagram).toBeDefined();
    expect(authDiagram).toBeDefined();
    expect(requestDiagram?.type).toBe("api-request-flow");
    expect(authDiagram?.type).toBe("authentication-flow");
    expect(requestDiagram?.nodes.every((node) => node.evidence.length > 0 && node.explanation.length > 0)).toBe(true);
    expect(requestDiagram?.edges.every((edge) => edge.evidence.length > 0 && edge.explanation?.length)).toBe(true);
    expect(authenticationFlowDiagram("unsupported", repository(nextApiFixture), analyzePhase3(files(nextApiFixture)).findings)).toBeNull();
  });

  it("keeps the system overview semantic and marks inferred paths", () => {
    const fixtureFiles = files(nextApiFixture);
    const phase3 = analyzePhase3(fixtureFiles);
    const findings = [...analyzeTechnologies(fixtureFiles), ...phase3.findings];
    const overview = systemOverviewDiagram("analysis-next", repository(nextApiFixture), findings);

    expect(overview).toBeDefined();
    expect(overview?.nodes.map((node) => node.plainEnglishLabel)).toEqual(expect.arrayContaining(["Person in a browser", "Web interface", "Application server"]));
    expect(overview?.nodes.map((node) => node.plainEnglishLabel)).not.toContain("Typed JavaScript source");
    expect(overview?.edges.some((edge) => edge.inferred)).toBe(true);
    expect(overview?.edges.every((edge) => edge.evidence.length > 0)).toBe(true);
  });
});
