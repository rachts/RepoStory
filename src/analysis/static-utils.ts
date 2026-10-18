import type { EvidenceReference } from "@/domain/evidence";
import type { RepositoryFile } from "@/domain/repository";
import { evidenceFor } from "@/analysis/evidence";
import { isSecretBearingPath, redactPath } from "@/shared/redaction";
import { normalizePath } from "@/shared/text";
import { DEFAULT_LIMITS, type AnalysisBudget } from "@/shared/limits";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
] as const;

export type KnownHttpMethod = (typeof HTTP_METHODS)[number];

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
const MAX_SOURCE_FILES = DEFAULT_LIMITS.maxFiles;

export function sourceFiles(files: RepositoryFile[], budget?: AnalysisBudget): RepositoryFile[] {
  budget?.check();
  const result: RepositoryFile[] = [];
  for (const file of files) {
    budget?.check();
    if (file.type === "file" && file.isAnalyzable !== false && !isSecretBearingPath(file.path)) result.push(file);
  }
  budget?.check();
  result.sort((left, right) => {
    budget?.check();
    return normalizePath(left.path).localeCompare(normalizePath(right.path));
  });
  budget?.check();
  return result.slice(0, MAX_SOURCE_FILES);
}

export function fileContent(file: RepositoryFile): string {
  return file.content ?? "";
}

/** Remove only standalone comments so URLs and inline expressions remain intact. */
export function withoutStandaloneComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function safeText(value: string): string {
  return redactPath(value).replace(/[\r\n\t]+/g, " ").trim();
}

export function safePath(value: string): string {
  return redactPath(safeText(normalizePath(value)));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function routePathFromSegments(segments: string[]): string {
  const filtered = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "index");
  return filtered.length ? `/${filtered.join("/")}` : "/";
}

export function joinRoutePaths(prefix: string | undefined, route: string): string {
  const normalizedPrefix = prefix?.trim() ?? "";
  const normalizedRoute = route.trim() || "/";
  const joined = `${normalizedPrefix}/${normalizedRoute}`.replace(/\/+/g, "/");
  const withLeadingSlash = joined.startsWith("/") ? joined : `/${joined}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/$/, "") : withLeadingSlash;
  return withoutTrailingSlash || "/";
}

export function normalizeHttpMethods(methods: string[]): string[] {
  const known = new Set(methods.map((method) => method.toUpperCase()));
  return [
    ...HTTP_METHODS.filter((method) => known.has(method)),
    ...(known.has("ALL") ? ["ALL"] : []),
    ...(known.has("UNKNOWN") || known.size === 0 ? ["UNKNOWN"] : []),
  ];
}

export function evidenceForPattern(file: RepositoryFile, reason: string, pattern?: RegExp): EvidenceReference {
  return evidenceFor(file, safeText(reason), pattern);
}

export function uniqueEvidence(evidence: EvidenceReference[], budget?: AnalysisBudget): EvidenceReference[] {
  const byId = new Map<string, EvidenceReference>();
  for (const item of evidence) {
    budget?.check();
    byId.set(item.id, item);
  }
  budget?.check();
  const unique = [...byId.values()];
  unique.sort((left, right) => {
    budget?.check();
    return left.id.localeCompare(right.id);
  });
  budget?.check();
  return unique;
}

export function parsePackageJson(file: RepositoryFile | undefined): Record<string, unknown> | null {
  if (!file?.content) return null;
  try {
    const parsed: unknown = JSON.parse(file.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function packageNames(packageFile: RepositoryFile | undefined, budget?: AnalysisBudget): string[] {
  const parsed = parsePackageJson(packageFile);
  if (!parsed) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    budget?.check();
    const dependencies = parsed[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      budget?.check();
      names.add(name);
    }
  }
  budget?.check();
  const sortedNames = [...names];
  sortedNames.sort((left, right) => {
    budget?.check();
    return left.localeCompare(right);
  });
  budget?.check();
  return sortedNames;
}

export function packageDependencyEvidence(packageFile: RepositoryFile | undefined, packageName: string, reason: string): EvidenceReference[] {
  if (!packageFile) return [];
  return [evidenceForPattern(packageFile, reason, new RegExp(`"${escapeRegExp(packageName)}"`))];
}

export interface ModuleAlias {
  pattern: string;
  target: string;
}

export function moduleAliases(files: RepositoryFile[], budget?: AnalysisBudget): ModuleAlias[] {
  let tsconfig: RepositoryFile | undefined;
  for (const file of files) {
    budget?.check();
    if (normalizePath(file.path).toLowerCase() === "tsconfig.json") {
      tsconfig = file;
      break;
    }
  }
  if (!tsconfig?.content) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(tsconfig.content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const compilerOptions = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== "object" || Array.isArray(compilerOptions)) return [];
  const paths = (compilerOptions as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return [];
  const aliases: ModuleAlias[] = [];
  for (const [pattern, targetValue] of Object.entries(paths)) {
    budget?.check();
    const target = Array.isArray(targetValue) ? targetValue[0] : undefined;
    if (typeof target === "string") aliases.push({ pattern, target });
  }
  budget?.check();
  aliases.sort((left, right) => {
    budget?.check();
    return left.pattern.localeCompare(right.pattern);
  });
  budget?.check();
  return aliases;
}

function normalizeModulePath(path: string): string {
  const parts: string[] = [];
  for (const part of normalizePath(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function moduleCandidates(basePath: string): string[] {
  const extension = MODULE_EXTENSIONS.find((item) => basePath.endsWith(item));
  if (extension) return [basePath, `${basePath}/index${extension}`];
  return [basePath, ...MODULE_EXTENSIONS.map((item) => `${basePath}${item}`), ...MODULE_EXTENSIONS.map((item) => `${basePath}/index${item}`)];
}

export function resolveLocalModule(sourcePath: string, specifier: string, knownPaths: Set<string>, aliases: ModuleAlias[] = [], budget?: AnalysisBudget): { targetPath: string; confidence: "high" | "medium" } | null {
  const normalizedSpecifier = normalizePath(specifier.trim());
  let basePath: string;
  let confidence: "high" | "medium";
  if (normalizedSpecifier.startsWith("./") || normalizedSpecifier.startsWith("../")) {
    const sourceParts = normalizePath(sourcePath).split("/");
    sourceParts.pop();
    basePath = normalizeModulePath([...sourceParts, normalizedSpecifier].join("/"));
    confidence = "high";
  } else if (normalizedSpecifier.startsWith("@/")) {
    basePath = normalizeModulePath(`src/${normalizedSpecifier.slice(2)}`);
    confidence = "medium";
  } else if (normalizedSpecifier.startsWith("~/")) {
    basePath = normalizeModulePath(`src/${normalizedSpecifier.slice(2)}`);
    confidence = "medium";
  } else if (normalizedSpecifier.startsWith("src/")) {
    basePath = normalizeModulePath(normalizedSpecifier);
    confidence = "medium";
  } else {
    let alias: ModuleAlias | undefined;
    for (const candidate of aliases) {
      budget?.check();
      const pattern = normalizePath(candidate.pattern);
      if (pattern.endsWith("/*") ? normalizedSpecifier.startsWith(pattern.slice(0, -1)) : normalizedSpecifier === pattern) {
        alias = candidate;
        break;
      }
    }
    if (!alias) return null;
    const pattern = normalizePath(alias.pattern);
    const target = normalizePath(alias.target);
    const aliasPrefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : pattern;
    const suffix = pattern.endsWith("/*") ? normalizedSpecifier.slice(aliasPrefix.length) : "";
    basePath = normalizeModulePath(`${target.replace(/\/\*$/, "")}${suffix ? `/${suffix}` : ""}`);
    confidence = "medium";
  }

  for (const candidate of moduleCandidates(basePath)) {
    budget?.check();
    if (knownPaths.has(candidate)) return { targetPath: candidate, confidence };
  }
  return null;
}

export function linePattern(value: string): RegExp {
  return new RegExp(escapeRegExp(value));
}
