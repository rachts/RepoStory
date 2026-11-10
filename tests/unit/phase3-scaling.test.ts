import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { planIncrementalAnalysis } from "@/infrastructure/incremental/incremental-analyzer";
import { HeuristicStreamingAnalyzer, TypeScriptAstStreamingAnalyzer } from "@/application/analysis/streaming-analyzer";
import type { RepositoryFile } from "@/domain/repository";

describe("Workstream 11: Phase 3 Scaling Foundations", () => {
  describe("Incremental Analysis Foundations", () => {
    it("plans incremental analysis comparing base and head commits using compare API", async () => {
      const origFlag = process.env.INCREMENTAL_ANALYSIS_ENABLED;
      try {
        process.env.INCREMENTAL_ANALYSIS_ENABLED = "true";

        const previousFiles: RepositoryFile[] = [
          { path: "src/unchanged.ts", type: "file", content: "export const keep = true;", isAnalyzable: true },
          { path: "src/modified.ts", type: "file", content: "old content", isAnalyzable: true },
          { path: "src/deleted.ts", type: "file", content: "to be deleted", isAnalyzable: true },
        ];

        const mockFetch = async () => {
          return new Response(JSON.stringify({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            files: [
              { filename: "src/modified.ts", status: "modified" },
              { filename: "src/added.ts", status: "added" },
              { filename: "src/deleted.ts", status: "removed" },
            ],
          }));
        };

        const plan = await planIncrementalAnalysis(
          "acme",
          "repo",
          "base123",
          "head456",
          previousFiles,
          mockFetch as unknown as typeof fetch,
        );

        expect(plan.reusableFiles.map((f) => f.path)).toEqual(["src/unchanged.ts"]);
        expect(plan.changedPathsToFetch).toEqual(["src/modified.ts", "src/added.ts"]);
        expect(plan.deletedPaths).toEqual(["src/deleted.ts"]);
      } finally {
        process.env.INCREMENTAL_ANALYSIS_ENABLED = origFlag;
      }
    });
  });

  describe("Streaming Static Analyzers", () => {
    async function* makeFileStream(files: RepositoryFile[]): AsyncIterable<RepositoryFile> {
      for (const file of files) {
        yield file;
      }
    }

    it("HeuristicStreamingAnalyzer extracts findings from stream", async () => {
      const analyzer = new HeuristicStreamingAnalyzer();
      const files: RepositoryFile[] = [
        { path: "package.json", type: "file", content: JSON.stringify({ dependencies: { next: "15.0.0" } }), isAnalyzable: true },
        { path: "prisma/schema.prisma", type: "file", content: "datasource db { provider = 'postgresql' }", isAnalyzable: true },
      ];

      const findings = await analyzer.analyze(makeFileStream(files));
      expect(findings.some((f) => f.technicalLabel === "Next.js")).toBe(true);
      expect(findings.some((f) => f.technicalLabel === "Prisma")).toBe(true);
    });

    it("TypeScriptAstStreamingAnalyzer parses TypeScript AST to detect imports and clients", async () => {
      const analyzer = new TypeScriptAstStreamingAnalyzer();
      const files: RepositoryFile[] = [
        {
          path: "src/lib/supabase.ts",
          type: "file",
          content: 'import { createClient } from "@supabase/supabase-js";\nexport const client = createClient();',
          isAnalyzable: true,
        },
        {
          path: "src/app/api/test.ts",
          type: "file",
          content: 'import { NextResponse } from "next/server";\nexport function GET() { return NextResponse.json({}); }',
          isAnalyzable: true,
        },
      ];

      const findings = await analyzer.analyze(makeFileStream(files));
      expect(findings.some((f) => f.technicalLabel === "Supabase Client")).toBe(true);
      expect(findings.some((f) => f.technicalLabel === "Next.js Server API")).toBe(true);
    });

    it("runs TypeScriptAstStreamingAnalyzer on disk fixture file test/fixtures/ast-sample.ts", async () => {
      const analyzer = new TypeScriptAstStreamingAnalyzer();
      const fixturePath = path.resolve(__dirname, "../../test/fixtures/ast-sample.ts");
      const fixtureContent = fs.readFileSync(fixturePath, "utf8");

      const files: RepositoryFile[] = [
        {
          path: "src/server/sample.ts",
          type: "file",
          content: fixtureContent,
          isAnalyzable: true,
        },
      ];

      const findings = await analyzer.analyze(makeFileStream(files));
      expect(findings.some((f) => f.technicalLabel === "Supabase Client")).toBe(true);
      expect(findings.some((f) => f.technicalLabel === "Next.js Server API")).toBe(true);
    });
  });
});
