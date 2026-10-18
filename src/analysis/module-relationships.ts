import type { ModuleRelationship } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { DEFAULT_LIMITS } from "@/shared/limits";
import { evidenceForPattern, fileContent, linePattern, moduleAliases, normalizeModulePath, resolveLocalModule, safePath, safeText, sourceFiles, uniqueEvidence, withoutStandaloneComments } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";

interface ImportCandidate {
  specifier: string;
  importType: ModuleRelationship["importType"];
  pattern: RegExp;
}

export function importCandidates(content: string, budget?: AnalysisBudget, maxCandidates: number = DEFAULT_LIMITS.maxImportCandidates): ImportCandidate[] {
  const candidateLimit = Number.isSafeInteger(maxCandidates) && maxCandidates >= 0 ? maxCandidates : DEFAULT_LIMITS.maxImportCandidates;
  budget?.check();
  if (candidateLimit === 0) return [];
  const boundedContent = content.length > DEFAULT_LIMITS.maxContentBytes ? content.slice(0, DEFAULT_LIMITS.maxContentBytes) : content;
  const clean = withoutStandaloneComments(boundedContent);
  budget?.check();
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  const addMatches = (pattern: RegExp, importType: ImportCandidate["importType"]) => {
    budget?.check();
    const matches = clean.matchAll(pattern);
    for (const match of matches) {
      budget?.check();
      if (candidates.length >= candidateLimit) return;
      const specifier = match[1];
      if (!specifier) continue;
      const key = `${importType}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ specifier, importType, pattern: linePattern(specifier) });
      budget?.check();
    }
    budget?.check();
  };
  addMatches(/\bimport\s+(?:type\s+)?(?:[^"'`\n;]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g, "static");
  if (candidates.length < candidateLimit) addMatches(/\bexport\s+(?:type\s+)?[^"'`\n;]+?\s+from\s+["'`]([^"'`]+)["'`]/g, "static");
  if (candidates.length < candidateLimit) addMatches(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, "dynamic");
  if (candidates.length < candidateLimit) addMatches(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, "require");
  budget?.check();
  return candidates;
}

export function analyzeModuleRelationships(files: RepositoryFile[], budget?: AnalysisBudget, maxImportCandidates: number = DEFAULT_LIMITS.maxImportCandidates): ModuleRelationship[] {
  const analyzable = sourceFiles(files, budget);
  const knownPaths = new Set<string>();
  const fileByPath = new Map<string, RepositoryFile>();
  for (const file of analyzable) {
    budget?.check();
    const normalizedPath = normalizeModulePath(file.path);
    knownPaths.add(normalizedPath);
    if (!fileByPath.has(normalizedPath)) fileByPath.set(normalizedPath, file);
  }
  const aliases = moduleAliases(analyzable, budget);
  const relationships: ModuleRelationship[] = [];
  for (const source of analyzable) {
    budget?.check();
    const candidates = importCandidates(fileContent(source), budget, maxImportCandidates);
    budget?.check();
    for (const candidate of candidates) {
      budget?.check();
      const resolved = resolveLocalModule(source.path, candidate.specifier, knownPaths, aliases, budget);
      budget?.check();
      if (!resolved) continue;
      const target = fileByPath.get(resolved.targetPath);
      if (!target) continue;
      const sourcePath = safePath(source.path);
      const targetPath = safePath(target.path);
      const evidence = uniqueEvidence([
        evidenceForPattern(source, `imports local module ${targetPath} via ${candidate.importType}`, candidate.pattern),
        evidenceForPattern(target, `is the resolved local module imported by ${sourcePath}`),
      ], budget);
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
  for (const relationship of relationships) {
    budget?.check();
    byId.set(relationship.id, relationship);
  }
  budget?.check();
  const sortedRelationships = [...byId.values()];
  sortedRelationships.sort((left, right) => {
    budget?.check();
    return left.id.localeCompare(right.id);
  });
  budget?.check();
  return sortedRelationships;
}

export const analyzeModules = analyzeModuleRelationships;
export const detectModuleRelationships = analyzeModuleRelationships;
export const findModuleRelationships = analyzeModuleRelationships;
export const analyzeRelationships = analyzeModuleRelationships;
