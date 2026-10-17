import type { AnalysisFinding } from "@/domain/finding";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { Repository, RepositoryFile } from "@/domain/repository";
import { nowIso, opaqueId, stableId } from "@/shared/ids";

export function repositoryStructureDiagram(analysisId: string, repository: Repository, files: RepositoryFile[], findings: AnalysisFinding[]): Diagram {
  const createdAt = nowIso();
  const fallbackEvidence = findings.flatMap((finding) => finding.evidence).slice(0, 1);
  const roots = [...new Set(files.map((file) => file.path.split("/")[0]).filter((root): root is string => Boolean(root)))].sort();
  const nodes: DiagramNode[] = [{ id: "repo", technicalLabel: repository.name, plainEnglishLabel: "Repository", explanation: repository.description ?? "Analyzed repository", kind: "directory", visible: true, confidence: "high", evidence: fallbackEvidence }, ...roots.map((root) => ({ id: stableId("dir", root), technicalLabel: root, plainEnglishLabel: `${root} directory`, explanation: "Top-level source area.", kind: "directory" as const, visible: true, confidence: "medium" as const, evidence: findings.find((f) => f.technicalLabel === root)?.evidence ?? fallbackEvidence }))];
  const edges: DiagramEdge[] = nodes.slice(1).map((node) => ({ id: stableId("edge", "repo", node.id), source: "repo", target: node.id, label: "contains", visible: true, confidence: "high" as const, evidence: node.evidence }));
  return { id: opaqueId("diagram"), analysisId, type: "repository-structure", title: "Repository structure", description: "Top-level areas inferred from analyzed files.", direction: "TB", nodes, edges, createdAt, updatedAt: createdAt };
}

export function systemOverviewDiagram(analysisId: string, repository: Repository, findings: AnalysisFinding[]): Diagram | null {
  const createdAt = nowIso(); const technologies = findings.filter((f) => f.kind === "technology");
  const evidence = findings.flatMap((finding) => finding.evidence);
  if (!technologies.length || !evidence.length) return null;
  const nodes: DiagramNode[] = [{ id: "user", technicalLabel: "User", plainEnglishLabel: "Person using the application", explanation: "The person who interacts with the application described by the repository.", kind: "person", visible: true, confidence: "medium", evidence: evidence.slice(0, 1) }, { id: "app", technicalLabel: repository.name, plainEnglishLabel: "Application", explanation: "The repository's software system.", kind: "frontend", visible: true, confidence: "high", evidence: evidence.slice(0, 1) }, ...technologies.map((f) => ({ id: f.id, technicalLabel: f.technicalLabel, plainEnglishLabel: f.plainEnglishLabel, explanation: f.explanation, kind: (f.technicalLabel.includes("React") || f.technicalLabel === "Next.js" ? "frontend" : "service") as "frontend" | "service", visible: true, confidence: f.confidence, evidence: f.evidence }))];
  const edges: DiagramEdge[] = [{ id: stableId("edge", "user", "app"), source: "user", target: "app", label: "uses", visible: true, confidence: "medium", evidence: evidence.slice(0, 1) }, ...technologies.map((f) => ({ id: stableId("edge", "app", f.id), source: "app", target: f.id, label: "built with", visible: true, confidence: f.confidence, evidence: f.evidence }))];
  return { id: opaqueId("diagram"), analysisId, type: "system-overview", title: "System overview", description: "A conservative overview based only on repository evidence.", direction: "LR", nodes, edges, createdAt, updatedAt: createdAt };
}
