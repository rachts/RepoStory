import type { AnalysisFinding } from "@/domain/finding";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { Repository, RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { nowIso, opaqueId, stableId } from "@/shared/ids";
import { safeText, uniqueEvidence } from "@/analysis/static-utils";
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
  const frontendEvidence: AnalysisFinding[] = [];
  const serverEvidence: AnalysisFinding[] = [];
  const databases: AnalysisFinding[] = [];
  const integrations: AnalysisFinding[] = [];
  const authentication: AnalysisFinding[] = [];
  for (const finding of findings) {
    budget?.check();
    if (finding.kind === "technology") technologies.push(finding);
    if (finding.kind === "technology" && /react|next\.js|frontend|web application/i.test(finding.technicalLabel)) frontendEvidence.push(finding);
    if (finding.kind === "api-route" || finding.kind === "route" || finding.kind === "authentication" || finding.kind === "database" || finding.kind === "database-client" || finding.kind === "external-service" || finding.kind === "integration") serverEvidence.push(finding);
    if (finding.kind === "database" || finding.kind === "database-client") databases.push(finding);
    if (finding.kind === "external-service" || finding.kind === "integration") integrations.push(finding);
    if (finding.kind === "authentication") authentication.push(finding);
  }

  const availableEvidence = uniqueEvidence([...technologies, ...serverEvidence].flatMap((finding) => finding.evidence), budget);
  if (!availableEvidence.length) return null;

  const evidenceFor = (items: readonly AnalysisFinding[]): AnalysisFinding["evidence"] => safeEvidence(uniqueEvidence(items.flatMap((finding) => finding.evidence), budget), budget);
  const weakestConfidence = (items: readonly AnalysisFinding[], fallback: AnalysisFinding["confidence"] = "medium"): AnalysisFinding["confidence"] => {
    if (!items.length) return fallback;
    if (items.some((item) => item.confidence === "needs-verification")) return "needs-verification";
    if (items.some((item) => item.confidence === "low")) return "low";
    if (items.some((item) => item.confidence === "medium")) return "medium";
    return "high";
  };
  const technicalTechnologyLabel = technologies.map((finding) => safeText(finding.technicalLabel)).filter(Boolean).join(" / ") || redactPath(safeText(repository.name));
  const frontendTechnicalLabel = frontendEvidence.map((finding) => safeText(finding.technicalLabel)).filter(Boolean).join(" / ") || technicalTechnologyLabel;
  const nodes: DiagramNode[] = [];
  if (frontendEvidence.length) {
    nodes.push({ id: "system-person", technicalLabel: "Browser user", plainEnglishLabel: "Person in a browser", explanation: "A web interface is present, so this overview models a person opening the application in a browser. The repository does not contain a runtime observation of that person.", kind: "person", visible: true, confidence: "medium", evidence: evidenceFor(frontendEvidence).slice(0, 3) });
    nodes.push({ id: "system-frontend", technicalLabel: `${frontendTechnicalLabel} frontend`, plainEnglishLabel: "Web interface", explanation: `The repository shows ${frontendEvidence.map((finding) => safeText(finding.plainEnglishLabel)).join(" and ") || "a web interface"}. This is the part a person interacts with in the browser.`, kind: "frontend", visible: true, confidence: weakestConfidence(frontendEvidence, "high"), evidence: evidenceFor(frontendEvidence) });
  }

  const hasServerPath = serverEvidence.length > 0;
  if (hasServerPath) {
    nodes.push({ id: "system-backend", technicalLabel: "Application server", plainEnglishLabel: "Application server", explanation: "The repository contains server-side request handling or application logic supported by route, access, data, or service evidence.", kind: "backend", visible: true, confidence: weakestConfidence(serverEvidence), evidence: evidenceFor(serverEvidence) });
  } else if (technologies.length && !frontendEvidence.length) {
    nodes.push({ id: "system-application", technicalLabel: technicalTechnologyLabel, plainEnglishLabel: "Application building blocks", explanation: "The repository contains technology evidence, but a complete client or server path was not confirmed.", kind: "service", visible: true, confidence: weakestConfidence(technologies, "medium"), evidence: evidenceFor(technologies) });
  }

  if (databases.length) {
    nodes.push({ id: "system-data", technicalLabel: databases.map((finding) => safeText(finding.technicalLabel)).join(" / "), plainEnglishLabel: "Application data", explanation: "The repository contains evidence of a database or versioned data changes. Static analysis does not prove when data is read or saved at runtime.", kind: "database", visible: true, confidence: weakestConfidence(databases), evidence: evidenceFor(databases) });
  }
  if (integrations.length) {
    nodes.push({ id: "system-external-service", technicalLabel: integrations.map((finding) => safeText(finding.technicalLabel)).join(" / "), plainEnglishLabel: "Connected service", explanation: "The repository contains evidence of a named external service or external HTTP call. Static analysis cannot prove that every request reaches the service.", kind: "service", visible: true, confidence: weakestConfidence(integrations), evidence: evidenceFor(integrations) });
  }
  if (authentication.length) {
    nodes.push({ id: "system-authentication", technicalLabel: "Authentication boundary", plainEnglishLabel: "Sign-in and access checks", explanation: "The repository contains authentication, session, token, or access-check evidence. Static analysis cannot prove which requests are protected.", kind: "backend", visible: true, confidence: weakestConfidence(authentication), evidence: evidenceFor(authentication) });
  }

  if (!nodes.length) return null;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges: DiagramEdge[] = [];
  const addEdge = (source: string, target: string, label: string, explanation: string, items: readonly AnalysisFinding[], confidence: AnalysisFinding["confidence"] = "medium"): void => {
    const sourceNode = nodesById.get(source);
    const targetNode = nodesById.get(target);
    if (!sourceNode || !targetNode) return;
    edges.push({ id: stableId("edge", source, target), source, target, label, explanation, visible: true, inferred: confidence !== "high", confidence, evidence: evidenceFor(items).slice(0, 4) });
  };

  if (nodesById.has("system-person") && nodesById.has("system-frontend")) addEdge("system-person", "system-frontend", "opens", "A person opens the application in a browser.", frontendEvidence, "medium");
  if (nodesById.has("system-frontend") && nodesById.has("system-backend")) addEdge("system-frontend", "system-backend", "sends requests", "The web interface appears to send requests to the application server.", serverEvidence, "medium");
  if (nodesById.has("system-backend") && nodesById.has("system-data")) addEdge("system-backend", "system-data", "reads or saves", "Database evidence suggests that server-side application logic may read or save application data.", databases, "medium");
  if (nodesById.has("system-backend") && nodesById.has("system-external-service")) addEdge("system-backend", "system-external-service", "contacts", "External-service evidence suggests that server-side application logic may contact a connected service.", integrations, "medium");
  if (nodesById.has("system-backend") && nodesById.has("system-authentication")) addEdge("system-backend", "system-authentication", "checks access", "Authentication evidence suggests that application requests may pass through sign-in or access checks.", authentication, "medium");
  if (!edges.length && nodes.length > 1) addEdge(nodes[0]!.id, nodes[1]!.id, "connects", "The repository shows these application parts, but their runtime connection could not be confirmed.", technologies, "medium");

  return { id: opaqueId("diagram"), analysisId, type: "system-overview", title: "System overview", description: "A simplified view of the main application parts. Solid lines are directly supported; dashed lines are inferred from repository evidence.", direction: "LR", nodes, edges, createdAt, updatedAt: createdAt };
}
