import { describe, expect, it } from "vitest";
import type { RepositoryFile, Repository } from "@/domain/repository";
import { analyzeApiRoutes } from "@/analysis/routes";
import { analyzeModuleRelationships } from "@/analysis/module-relationships";
import { analyzeDatabaseEvidence } from "@/analysis/database";
import { analyzeExternalIntegrations } from "@/analysis/integrations";
import { analyzeAuthentication } from "@/analysis/authentication";
import { analyzePhase3 } from "@/analysis/phase3";
import { apiRequestFlowDiagram, authenticationFlowDiagram } from "@/analysis/flow-diagrams";
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

  it("resolves local static imports without executing repository code", () => {
    const relationships = analyzeModuleRelationships(files(nextApiFixture));
    expect(relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "src/app/api/users/service.ts", targetFile: "src/lib/users.ts", importType: "static", relationship: "imports" }),
    ]));
    expect(relationships.every((relationship) => relationship.evidence.length > 0 && relationship.plainEnglishLabel.length > 0)).toBe(true);
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
});
