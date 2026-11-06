import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisFinding } from "@/domain/finding";
import { opaqueId } from "@/shared/ids";
import ts from "typescript";

export interface StreamingAnalyzer {
  readonly name: string;
  analyze(fileStream: AsyncIterable<RepositoryFile>): Promise<AnalysisFinding[]>;
}

export class HeuristicStreamingAnalyzer implements StreamingAnalyzer {
  public readonly name = "heuristic-streaming-analyzer";

  public async analyze(fileStream: AsyncIterable<RepositoryFile>): Promise<AnalysisFinding[]> {
    const findings: AnalysisFinding[] = [];
    for await (const file of fileStream) {
      if (!file.content) continue;
      if (file.path.endsWith("package.json") && file.content.includes('"next"')) {
        findings.push({
          id: opaqueId("finding"),
          kind: "technology",
          technicalLabel: "Next.js",
          plainEnglishLabel: "Next.js Web Framework",
          explanation: "Next.js was detected in package.json dependencies.",
          confidence: "high",
          evidence: [{ id: opaqueId("evidence"), filePath: file.path, reason: "Dependency declaration in package.json" }],
        });
      }
      if (file.path.endsWith("prisma/schema.prisma") || file.content.includes("datasource db")) {
        findings.push({
          id: opaqueId("finding"),
          kind: "database",
          technicalLabel: "Prisma",
          plainEnglishLabel: "Prisma Database ORM",
          explanation: "Prisma schema configuration detected.",
          confidence: "high",
          evidence: [{ id: opaqueId("evidence"), filePath: file.path, reason: "Prisma schema declaration" }],
        });
      }
    }
    return findings;
  }
}

export class TypeScriptAstStreamingAnalyzer implements StreamingAnalyzer {
  public readonly name = "typescript-ast-streaming-analyzer";

  public async analyze(fileStream: AsyncIterable<RepositoryFile>): Promise<AnalysisFinding[]> {
    const findings: AnalysisFinding[] = [];
    for await (const file of fileStream) {
      if (!file.content) continue;
      if (!/\.(tsx?|mts|cts)$/i.test(file.path)) continue;

      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
      );

      ts.forEachChild(sourceFile, (node) => {
        if (ts.isImportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (ts.isStringLiteral(specifier)) {
            const moduleName = specifier.text;
            if (moduleName.startsWith("@supabase/")) {
              findings.push({
                id: opaqueId("finding"),
                kind: "database",
                technicalLabel: "Supabase Client",
                plainEnglishLabel: "Supabase Database Client",
                explanation: `TypeScript AST detected import of "${moduleName}" in ${file.path}.`,
                confidence: "high",
                evidence: [{ id: opaqueId("evidence"), filePath: file.path, reason: `Import declaration of ${moduleName}` }],
              });
            } else if (moduleName === "next/server" || moduleName === "next/navigation") {
              findings.push({
                id: opaqueId("finding"),
                kind: "technology",
                technicalLabel: "Next.js Server API",
                plainEnglishLabel: "Next.js Server Navigation & Routing",
                explanation: `TypeScript AST detected import of "${moduleName}" in ${file.path}.`,
                confidence: "high",
                evidence: [{ id: opaqueId("evidence"), filePath: file.path, reason: `Import declaration of ${moduleName}` }],
              });
            }
          }
        }
      });
    }
    return findings;
  }
}
