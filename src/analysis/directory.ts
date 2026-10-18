import type { AnalysisFinding } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceFor } from "@/analysis/evidence";
import { sourceFiles } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath, redactSecrets } from "@/shared/redaction";
import { normalizePath } from "@/shared/text";

export function analyzeDirectories(files: RepositoryFile[], budget?: AnalysisBudget): AnalysisFinding[] {
  const dirs = new Map<string, RepositoryFile>();
  for (const file of sourceFiles(files, budget)) {
    budget?.check();
    const path = normalizePath(file.path);
    const root = path.split("/")[0];
    if (root && path.includes("/")) dirs.set(root, { ...file, path });
  }
  budget?.check();
  const sortedDirs = [...dirs].sort(([left], [right]) => {
    budget?.check();
    return left.localeCompare(right);
  });
  budget?.check();
  const findings: AnalysisFinding[] = [];
  for (const [name, file] of sortedDirs) {
    budget?.check();
    const safeName = redactPath(name);
    findings.push({
      id: stableId("directory", name),
      kind: "directory",
      technicalLabel: safeName,
      plainEnglishLabel: `${safeName} directory`,
      explanation: redactSecrets(`Contains analyzed files under ${safeName}/.`),
      confidence: "medium",
      evidence: [evidenceFor(file, `directory ${safeName} contains source files`)],
    });
  }
  return findings;
}
