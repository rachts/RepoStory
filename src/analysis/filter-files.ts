import type { RepositoryFile } from "@/domain/repository";
import { DEFAULT_LIMITS, type AnalysisBudget, type AnalysisLimits } from "@/shared/limits";
import { normalizePath } from "@/shared/text";
import { isSecretBearingPath } from "@/shared/redaction";
const ignored = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)(\/|$)/;
const analyzable = /\.(tsx?|jsx?|css|scss|json|md|yml|yaml|toml|sql|prisma|py|go|rs|java|kt|rb|php|swift)$/i;
const analyzableBasename = /^(?:Dockerfile(?:\..*)?|Makefile|Gemfile|Procfile|Rakefile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|composer\.json)$/i;

function nonNegativeLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function fileSizeBytes(file: RepositoryFile): number {
  if (file.sizeBytes !== undefined && (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0)) return Number.POSITIVE_INFINITY;
  const contentBytes = file.content === undefined ? 0 : new TextEncoder().encode(file.content).byteLength;
  return Math.max(file.sizeBytes ?? 0, contentBytes);
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function filterFiles(files: RepositoryFile[], limits: AnalysisLimits = DEFAULT_LIMITS, budget?: AnalysisBudget): RepositoryFile[] {
  let total = 0;
  const filtered: RepositoryFile[] = [];
  const maxFiles = Number.isSafeInteger(limits.maxFiles) && limits.maxFiles >= 0 ? limits.maxFiles : DEFAULT_LIMITS.maxFiles;
  const maxFileBytes = nonNegativeLimit(limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes);
  const maxTotalBytes = nonNegativeLimit(limits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes);
  const maxPathLength = nonNegativeLimit(limits.maxPathLength, DEFAULT_LIMITS.maxPathLength);
  budget?.check();
  if (maxFiles === 0) return [];
  const sortedFiles = [...files];
  budget?.check();
  sortedFiles.sort((a, b) => {
    budget?.check();
    return normalizePath(a.path).localeCompare(normalizePath(b.path));
  });
  budget?.check();
  for (const file of sortedFiles) {
    budget?.check();
    const path = normalizePath(file.path); const size = fileSizeBytes(file);
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const isSafeEnvExample = /^\.env\.(example|sample|template)$/i.test(basename);
    const excluded = file.type !== "file" ? "directory entry" : !isSafeRelativePath(path) || path.length > maxPathLength ? "invalid or overly long path" : isSecretBearingPath(path) ? "secret-bearing file" : ignored.test(path) ? "generated or dependency directory" : !analyzable.test(path) && !analyzableBasename.test(basename) && !isSafeEnvExample ? "unsupported file type" : size > maxFileBytes ? "file exceeds size limit" : total + size > maxTotalBytes ? "total size limit" : undefined;
    if (!excluded) total += size;
    if (!excluded) filtered.push({ ...file, path, sizeBytes: size, isAnalyzable: true });
    if (filtered.length >= maxFiles) break;
  }
  budget?.check();
  return filtered;
}
