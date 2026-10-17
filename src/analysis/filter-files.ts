import type { RepositoryFile } from "@/domain/repository";
import { DEFAULT_LIMITS, type AnalysisBudget, type AnalysisLimits } from "@/shared/limits";
import { normalizePath } from "@/shared/text";
import { isSecretBearingPath } from "@/shared/redaction";
const ignored = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)(\/|$)/;
const analyzable = /\.(tsx?|jsx?|css|scss|json|md|yml|yaml|toml|sql|prisma|py|go|rs|java|kt|rb|php|swift)$/i;
export function filterFiles(files: RepositoryFile[], limits: AnalysisLimits = DEFAULT_LIMITS, budget?: AnalysisBudget): RepositoryFile[] {
  let total = 0;
  const filtered: RepositoryFile[] = [];
  for (const file of [...files].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)))) {
    budget?.check();
    const path = normalizePath(file.path); const size = file.sizeBytes ?? file.content?.length ?? 0;
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const isSafeEnvExample = /^\.env\.(example|sample|template)$/i.test(basename);
    const excluded = isSecretBearingPath(path) ? "secret-bearing file" : ignored.test(path) ? "generated or dependency directory" : !analyzable.test(path) && !isSafeEnvExample ? "unsupported file type" : size > limits.maxFileBytes ? "file exceeds size limit" : total + size > limits.maxTotalBytes ? "total size limit" : undefined;
    if (!excluded) total += size;
    if (!excluded) filtered.push({ ...file, path, isAnalyzable: true });
    if (filtered.length >= limits.maxFiles) break;
  }
  return filtered;
}
