import type { ModuleRelationship } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceForPattern, fileContent, linePattern, moduleAliases, resolveLocalModule, safePath, safeText, sourceFiles, uniqueEvidence, withoutStandaloneComments } from "@/analysis/static-utils";
import { normalizePath } from "@/shared/text";
import { stableId } from "@/shared/ids";

interface ImportCandidate {
  specifier: string;
  importType: ModuleRelationship["importType"];
  pattern: RegExp;
}

function importCandidates(content: string): ImportCandidate[] {
  const clean = withoutStandaloneComments(content);
  const candidates: ImportCandidate[] = [];
  const addMatches = (pattern: RegExp, importType: ImportCandidate["importType"]) => {
    for (const match of clean.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      candidates.push({ specifier, importType, pattern: linePattern(specifier) });
    }
  };
  addMatches(/\bimport\s+(?:type\s+)?(?:[^"'`\n;]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g, "static");
  addMatches(/\bexport\s+(?:type\s+)?[^"'`\n;]+?\s+from\s+["'`]([^"'`]+)["'`]/g, "static");
  addMatches(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, "dynamic");
  addMatches(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, "require");
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.importType}:${candidate.specifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyzeModuleRelationships(files: RepositoryFile[], budget?: AnalysisBudget): ModuleRelationship[] {
  const analyzable = sourceFiles(files);
  const knownPaths = new Set(analyzable.map((file) => normalizePath(file.path)));
  const fileByPath = new Map(analyzable.map((file) => [normalizePath(file.path), file]));
  const aliases = moduleAliases(analyzable);
  const relationships: ModuleRelationship[] = [];
  for (const source of analyzable) {
    budget?.check();
    for (const candidate of importCandidates(fileContent(source))) {
      budget?.check();
      const resolved = resolveLocalModule(source.path, candidate.specifier, knownPaths, aliases);
      if (!resolved) continue;
      const target = fileByPath.get(resolved.targetPath);
      if (!target) continue;
      const sourcePath = safePath(source.path);
      const targetPath = safePath(target.path);
      const evidence = uniqueEvidence([
        evidenceForPattern(source, `imports local module ${targetPath} via ${candidate.importType}`, candidate.pattern),
        evidenceForPattern(target, `is the resolved local module imported by ${sourcePath}`),
      ]);
      relationships.push({
        id: stableId("module-relationship", sourcePath, targetPath, candidate.importType),
        kind: "module-relationship",
        technicalLabel: `${sourcePath} -> ${targetPath}`,
        plainEnglishLabel: `${sourcePath} uses ${targetPath}`,
        explanation: `${sourcePath} references ${targetPath} through a ${candidate.importType} import. The relationship was resolved against files in the repository without executing code.`,
        technicalDetail: `specifier=${safeText(candidate.specifier)}; importType=${candidate.importType}`,
        confidence: resolved.confidence,
        evidence,
        source: sourcePath,
        target: targetPath,
        sourceFile: sourcePath,
        targetFile: targetPath,
        sourcePath,
        targetPath,
        specifier: safeText(candidate.specifier),
        importType: candidate.importType,
        importKind: candidate.importType,
        relationship: "imports",
      });
    }
  }
  const byId = new Map<string, ModuleRelationship>();
  for (const relationship of relationships) byId.set(relationship.id, relationship);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export const analyzeModules = analyzeModuleRelationships;
export const detectModuleRelationships = analyzeModuleRelationships;
export const findModuleRelationships = analyzeModuleRelationships;
export const analyzeRelationships = analyzeModuleRelationships;
