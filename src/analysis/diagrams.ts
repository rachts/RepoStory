import type { AnalysisFinding } from "@/domain/finding";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { Repository, RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { nowIso, opaqueId, stableId } from "@/shared/ids";
import { safeText } from "@/analysis/static-utils";
import { redactPath, redactSecrets } from "@/shared/redaction";

function safeEvidence(evidence: AnalysisFinding["evidence"], budget?: AnalysisBudget): AnalysisFinding["evidence"] {
  const safe: AnalysisFinding["evidence"] = [];
  for (const item of evidence) {
    budget?.check();
    safe.push({
      ...item,
      filePath: redactPath(item.filePath),
      ...(item.symbol !== undefined ? { symbol: redactSecrets(item.symbol) } : {}),
      ...(item.excerpt !== undefined ? { excerpt: redactSecrets(item.excerpt) } : {}),
      reason: redactSecrets(item.reason),
    });
  }
  budget?.check();
  return safe;
}

export function repositoryStructureDiagram(analysisId: string, repository: Repository, files: RepositoryFile[], findings: AnalysisFinding[], budget?: AnalysisBudget): Diagram {
  const createdAt = nowIso();
  const fallbackEvidence: AnalysisFinding["evidence"] = [];
  for (const finding of findings) {
    budget?.check();
    for (const item of finding.evidence) {
      budget?.check();
      fallbackEvidence.push(item);
      if (fallbackEvidence.length >= 1) break;
    }
    if (fallbackEvidence.length >= 1) break;
  }
  const rootSet = new Set<string>();
  for (const file of files) {
    budget?.check();
    const root = file.path.split("/")[0];
    if (root) rootSet.add(root);
  }
  const roots = [...rootSet];
  budget?.check();
  roots.sort((left, right) => { budget?.check(); return left.localeCompare(right); });
  budget?.check();
  const repositoryName = redactPath(safeText(repository.name));
  const repositoryDescription = safeText(repository.description ?? "Analyzed repository");
  const safeFallbackEvidence = safeEvidence(fallbackEvidence, budget);
  const nodes: DiagramNode[] = [{ id: "repo", technicalLabel: repositoryName, plainEnglishLabel: "Repository", explanation: repositoryDescription, kind: "directory", visible: true, confidence: "high", evidence: safeFallbackEvidence }];
  for (const root of roots) {
    budget?.check();
    const safeRoot = redactPath(root);
    let rootEvidence = safeFallbackEvidence;
    for (const finding of findings) {
      budget?.check();
      if (finding.technicalLabel === safeRoot) {
        rootEvidence = safeEvidence(finding.evidence, budget);
        break;
      }
    }
    nodes.push({ id: stableId("dir", root), technicalLabel: safeRoot, plainEnglishLabel: safeText(`${safeRoot} directory`), explanation: "Top-level source area.", kind: "directory", visible: true, confidence: "medium", evidence: rootEvidence });
  }
  const edges: DiagramEdge[] = [];
  for (const node of nodes.slice(1)) {
    budget?.check();
    edges.push({ id: stableId("edge", "repo", node.id), source: "repo", target: node.id, label: "contains", visible: true, confidence: "high", evidence: safeEvidence(node.evidence, budget) });
  }
  return { id: opaqueId("diagram"), analysisId, type: "repository-structure", title: "Repository structure", description: "Top-level areas inferred from analyzed files.", direction: "TB", nodes, edges, createdAt, updatedAt: createdAt };
}

export function systemOverviewDiagram(analysisId: string, repository: Repository, findings: AnalysisFinding[], budget?: AnalysisBudget): Diagram | null {
  const createdAt = nowIso();
  const technologies: AnalysisFinding[] = [];
  const evidence: AnalysisFinding["evidence"] = [];
  for (const finding of findings) {
    budget?.check();
    if (finding.kind === "technology") technologies.push(finding);
    for (const item of finding.evidence) {
      budget?.check();
      evidence.push(item);
    }
  }
  if (!technologies.length || !evidence.length) return null;
  const nodes: DiagramNode[] = [{ id: "user", technicalLabel: "User", plainEnglishLabel: "Person using the application", explanation: "The person who interacts with the application described by the repository.", kind: "person", visible: true, confidence: "medium", evidence: safeEvidence(evidence.slice(0, 1), budget) }, { id: "app", technicalLabel: redactPath(safeText(repository.name)), plainEnglishLabel: "Application", explanation: "The repository's software system.", kind: "frontend", visible: true, confidence: "high", evidence: safeEvidence(evidence.slice(0, 1), budget) }];
  for (const finding of technologies) {
    budget?.check();
    const technicalLabel = safeText(finding.technicalLabel);
    nodes.push({ id: finding.id, technicalLabel, plainEnglishLabel: safeText(finding.plainEnglishLabel), explanation: safeText(finding.explanation), ...(finding.technicalDetail ? { technicalDetail: safeText(finding.technicalDetail) } : {}), kind: technicalLabel.includes("React") || technicalLabel === "Next.js" ? "frontend" : "service", visible: true, confidence: finding.confidence, evidence: safeEvidence(finding.evidence, budget) });
  }
  const edges: DiagramEdge[] = [{ id: stableId("edge", "user", "app"), source: "user", target: "app", label: "uses", visible: true, confidence: "medium", evidence: safeEvidence(evidence.slice(0, 1), budget) }];
  for (const finding of technologies) {
    budget?.check();
    edges.push({ id: stableId("edge", "app", finding.id), source: "app", target: finding.id, label: "built with", visible: true, confidence: finding.confidence, evidence: safeEvidence(finding.evidence, budget) });
  }
  return { id: opaqueId("diagram"), analysisId, type: "system-overview", title: "System overview", description: "A conservative overview based only on repository evidence.", direction: "LR", nodes, edges, createdAt, updatedAt: createdAt };
}
