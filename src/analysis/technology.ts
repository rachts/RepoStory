import type { AnalysisFinding } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceFor } from "@/analysis/evidence";
import { fileContent, sourceFiles, withoutStandaloneComments } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath, redactSecrets } from "@/shared/redaction";

const signatures = [
  { file: /package\.json$/i, label: "Node.js / React", plain: "JavaScript packages and a web application", pattern: /["'](?:react|react-dom|@types\/react)["']\s*:/i },
  { file: /tsconfig\.json$/i, label: "TypeScript", plain: "Typed JavaScript source", pattern: /compilerOptions/i },
  { file: /next\.config\./i, label: "Next.js", plain: "A React framework for web delivery", pattern: /next/i },
  { file: /Dockerfile$/i, label: "Docker", plain: "Containerized runtime", pattern: /FROM/i },
];

export function analyzeTechnologies(files: RepositoryFile[], budget?: AnalysisBudget): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const analyzable = sourceFiles(files, budget);
  for (const signature of signatures) {
    budget?.check();
    let matchedFile: RepositoryFile | undefined;
    for (const candidate of analyzable) {
      budget?.check();
      if (signature.file.test(candidate.path) && signature.pattern.test(withoutStandaloneComments(fileContent(candidate)))) {
        matchedFile = candidate;
        break;
      }
    }
    if (!matchedFile) continue;
    const safeFilePath = redactPath(matchedFile.path);
    findings.push({
      id: stableId("technology", signature.label),
      kind: "technology",
      technicalLabel: signature.label,
      plainEnglishLabel: signature.plain,
      explanation: redactSecrets(`Detected from ${safeFilePath}.`),
      confidence: "high",
      evidence: [evidenceFor(matchedFile, `declares ${signature.label}`, signature.pattern)],
    });
  }
  return findings;
}
