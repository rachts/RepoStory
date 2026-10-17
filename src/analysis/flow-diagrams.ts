import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, ModuleRelationship } from "@/domain/finding";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { Repository } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { nowIso, opaqueId, stableId } from "@/shared/ids";
import { safePath, safeText, uniqueEvidence } from "@/analysis/static-utils";

type FlowFinding = AnalysisFinding & Partial<ApiRouteFinding>;

function routeFindings(findings: readonly AnalysisFinding[]): ApiRouteFinding[] {
  return findings
    .filter((finding): finding is FlowFinding => finding.kind === "api-route" || finding.kind === "route")
    .filter((finding): finding is ApiRouteFinding => typeof finding.routePath === "string" && Array.isArray(finding.methods) && typeof finding.filePath === "string")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function meaningfulAuthFindings(findings: readonly AnalysisFinding[]): AuthenticationFinding[] {
  return findings
    .filter((finding): finding is AuthenticationFinding => finding.kind === "authentication" && finding.evidence.length > 0 && finding.confidence !== "needs-verification")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function safeEvidence(evidence: AnalysisFinding["evidence"]): AnalysisFinding["evidence"] {
  return uniqueEvidence(evidence.map((item) => ({
    ...item,
    filePath: safePath(item.filePath),
    symbol: item.symbol ? safeText(item.symbol) : undefined,
    excerpt: item.excerpt ? safeText(item.excerpt) : undefined,
    reason: safeText(item.reason),
  })));
}

function fallbackEvidence(findings: readonly AnalysisFinding[]): NonNullable<AnalysisFinding["evidence"]> {
  return safeEvidence(findings.flatMap((finding) => finding.evidence)).slice(0, 3);
}

function nodeFromFinding(finding: AnalysisFinding, kind: DiagramNode["kind"], plainEnglishLabel = finding.plainEnglishLabel): DiagramNode {
  return {
    id: finding.id,
    technicalLabel: safeText(finding.technicalLabel),
    plainEnglishLabel: safeText(plainEnglishLabel),
    explanation: safeText(finding.explanation),
    technicalDetail: finding.technicalDetail ? safeText(finding.technicalDetail) : undefined,
    kind,
    visible: true,
    confidence: finding.confidence,
    evidence: safeEvidence(finding.evidence),
  };
}

function edge(idParts: string[], source: string, target: string, label: string, explanation: string, evidence: AnalysisFinding["evidence"], confidence: AnalysisFinding["confidence"]): DiagramEdge {
  return {
    id: stableId("flow-edge", ...idParts),
    source,
    target,
    label: safeText(label),
    explanation: safeText(explanation),
    visible: true,
    confidence,
    evidence: safeEvidence(evidence),
  };
}

/** Build a conservative request flow from API route, module, database, and integration findings. */
export function apiRequestFlowDiagram(analysisId: string, repository: Repository, findings: readonly AnalysisFinding[], relationships: readonly ModuleRelationship[] = [], budget?: AnalysisBudget): Diagram | null {
  budget?.check();
  const routes = routeFindings(findings);
  if (!routes.length) return null;
  const databases = findings.filter((finding) => finding.kind === "database" || finding.kind === "database-client").sort((left, right) => left.id.localeCompare(right.id));
  const integrations = findings.filter((finding) => finding.kind === "external-service" || finding.kind === "integration").sort((left, right) => left.id.localeCompare(right.id));
  const evidence = fallbackEvidence(routes);
  if (!evidence.length) return null;
  const createdAt = nowIso();
  const repositoryName = safeText(repository.name);
  const applicationNode: DiagramNode = {
    id: "request-app",
    technicalLabel: repositoryName,
    plainEnglishLabel: "Application request handler",
    explanation: "The repository contains the code that receives and processes HTTP requests.",
    kind: "backend",
    visible: true,
    confidence: routes.every((route) => route.confidence === "high") ? "high" : "medium",
    evidence,
  };
  const userNode: DiagramNode = {
    id: "request-user",
    technicalLabel: "User or client",
    plainEnglishLabel: "Person or client making a request",
    explanation: "A request must originate from a person, browser, or another client before reaching the detected endpoint.",
    kind: "person",
    visible: true,
    confidence: "medium",
    evidence: evidence.slice(0, 1),
  };
  const routeNodes = routes.map((route) => nodeFromFinding(route, "api", `${route.methods.join(", ")} ${route.routePath}`));

  const relatedRelationships = relationships
    .filter((relationship) => routes.some((route) => route.filePath === relationship.sourceFile || route.filePath === relationship.source))
    .sort((left, right) => left.id.localeCompare(right.id));
  const moduleNodes = new Map<string, DiagramNode>();
  for (const relationship of relatedRelationships) {
    budget?.check();
    if (moduleNodes.has(relationship.targetFile)) continue;
    moduleNodes.set(relationship.targetFile, {
      id: stableId("module-node", relationship.targetFile),
      technicalLabel: safePath(relationship.targetFile),
      plainEnglishLabel: `Module used by ${safePath(relationship.sourceFile)}`,
      explanation: relationship.explanation,
      kind: "file",
      visible: true,
      confidence: relationship.confidence,
      evidence: safeEvidence(relationship.evidence),
    });
  }

  const nodes: DiagramNode[] = [userNode, applicationNode, ...routeNodes, ...moduleNodes.values(), ...databases.map((finding) => nodeFromFinding(finding, "database")), ...integrations.map((finding) => nodeFromFinding(finding, "service"))];
  const edges: DiagramEdge[] = [
    edge(["request-user", "request-app"], "request-user", "request-app", "sends request", "The request enters the analyzed application.", evidence, "medium"),
    ...routes.map((route) => edge(["request-app", route.id], "request-app", route.id, "dispatches", `The application exposes ${route.methods.join(", ")} at ${route.routePath}.`, route.evidence, route.confidence)),
    ...relatedRelationships.map((relationship) => {
      const moduleId = stableId("module-node", relationship.targetFile);
      const route = routes.find((candidate) => candidate.filePath === relationship.sourceFile || candidate.filePath === relationship.source);
      return route ? edge([route.id, moduleId], route.id, moduleId, "imports", `The endpoint file imports ${safePath(relationship.targetFile)}.`, relationship.evidence, relationship.confidence) : null;
    }).filter((item): item is DiagramEdge => item !== null),
    ...databases.map((finding) => edge(["request-app", finding.id], "request-app", finding.id, "uses database evidence", "Static database evidence is present in the repository.", finding.evidence, finding.confidence)),
    ...integrations.map((finding) => edge(["request-app", finding.id], "request-app", finding.id, "calls service evidence", "Static client or dependency evidence indicates an external service integration.", finding.evidence, finding.confidence)),
  ];
  return {
    id: opaqueId("diagram"),
    analysisId,
    type: "api-request-flow",
    title: "API request flow",
    description: "A deterministic request path inferred from discovered HTTP routes and local module relationships.",
    direction: "LR",
    nodes,
    edges,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Build an authentication flow only when provider, token, session, or middleware evidence exists. */
export function authenticationFlowDiagram(analysisId: string, repository: Repository, findings: readonly AnalysisFinding[], relationships: readonly ModuleRelationship[] = [], budget?: AnalysisBudget): Diagram | null {
  budget?.check();
  const authFindings = meaningfulAuthFindings(findings);
  if (!authFindings.length) return null;
  const routes = routeFindings(findings);
  const evidence = fallbackEvidence(authFindings);
  if (!evidence.length) return null;
  const createdAt = nowIso();
  const repositoryName = safeText(repository.name);
  const userNode: DiagramNode = {
    id: "auth-user",
    technicalLabel: "User",
    plainEnglishLabel: "Person signing in",
    explanation: "The person or client that presents credentials or an authorization grant.",
    kind: "person",
    visible: true,
    confidence: "medium",
    evidence: evidence.slice(0, 1),
  };
  const appNode: DiagramNode = {
    id: "auth-app",
    technicalLabel: repositoryName,
    plainEnglishLabel: "Application access boundary",
    explanation: "The repository contains request handling that checks identity, sessions, tokens, or middleware.",
    kind: "backend",
    visible: true,
    confidence: authFindings.every((finding) => finding.confidence === "high") ? "high" : "medium",
    evidence,
  };
  const providerNodes = authFindings.map((finding) => nodeFromFinding(finding, finding.mechanism === "middleware" ? "backend" : "service", finding.provider));
  const tokenFindings = authFindings.filter((finding) => finding.mechanism === "jwt" || finding.mechanism === "session");
  const tokenNode = tokenFindings.length ? {
    id: "auth-session-token",
    technicalLabel: tokenFindings.map((finding) => finding.provider).join(" / "),
    plainEnglishLabel: "Session or token state",
    explanation: "The repository contains evidence of session or token state used after authentication.",
    kind: "service" as const,
    visible: true,
    confidence: tokenFindings.every((finding) => finding.confidence === "high") ? "high" as const : "medium" as const,
    evidence: safeEvidence(tokenFindings.flatMap((finding) => finding.evidence)),
  } : null;
  const routeNodes = routes.map((route) => nodeFromFinding(route, "api", `Detected endpoint ${route.routePath}`));
  const relatedRelationships = relationships.filter((relationship) => authFindings.some((finding) => finding.evidence.some((item) => item.filePath === relationship.sourceFile || item.filePath === relationship.source))).sort((left, right) => left.id.localeCompare(right.id));
  const moduleNodes = relatedRelationships.map((relationship) => ({
    id: stableId("auth-module", relationship.targetFile),
    technicalLabel: safePath(relationship.targetFile),
    plainEnglishLabel: "Authentication-related module",
    explanation: relationship.explanation,
    kind: "file" as const,
    visible: true,
    confidence: relationship.confidence,
    evidence: safeEvidence(relationship.evidence),
  })).filter((node, index, all) => all.findIndex((candidate) => candidate.id === node.id) === index);
  const nodes = [userNode, appNode, ...providerNodes, ...(tokenNode ? [tokenNode] : []), ...moduleNodes, ...routeNodes];
  const edges: DiagramEdge[] = [
    edge(["auth-user", "auth-app"], "auth-user", "auth-app", "requests access", "The user or client presents a request that the application must evaluate.", evidence, "medium"),
    ...authFindings.map((finding) => edge(["auth-user", finding.id], "auth-user", finding.id, finding.mechanism === "oauth" ? "authorizes with" : "authenticates with", `Static evidence identifies ${finding.provider} as part of the authentication boundary.`, finding.evidence, finding.confidence)),
    ...authFindings.map((finding) => edge([finding.id, "auth-app"], finding.id, "auth-app", "returns identity signal", `${finding.provider} evidence contributes an identity, token, session, or middleware check.`, finding.evidence, finding.confidence)),
    ...(tokenNode ? [edge(["auth-app", tokenNode.id], "auth-app", tokenNode.id, "reads or issues", "The application uses the detected session or token mechanism.", tokenNode.evidence, tokenNode.confidence)] : []),
    ...moduleNodes.map((node) => {
      const relationship = relatedRelationships.find((candidate) => stableId("auth-module", candidate.targetFile) === node.id);
      return relationship ? edge(["auth-app", node.id], "auth-app", node.id, "uses auth module", "An authentication-related module is connected to the detected auth evidence.", relationship.evidence, relationship.confidence) : null;
    }).filter((item): item is DiagramEdge => item !== null),
     ...routes.map((route) => edge(["auth-app", route.id], "auth-app", route.id, "may evaluate", `The repository contains authentication evidence and an endpoint at ${route.routePath}; static analysis cannot prove that this endpoint is protected.`, [...evidence, ...route.evidence], "needs-verification")),
  ];
  return {
    id: opaqueId("diagram"),
    analysisId,
    type: "authentication-flow",
    title: "Authentication flow",
    description: "A conservative identity and access path inferred only when authentication evidence is present.",
    direction: "LR",
    nodes,
    edges,
    createdAt,
    updatedAt: createdAt,
  };
}

export const generateApiRequestFlowDiagram = apiRequestFlowDiagram;
export const generateAuthenticationFlowDiagram = authenticationFlowDiagram;
export const generateApiRequestFlow = apiRequestFlowDiagram;
export const generateAuthenticationFlow = authenticationFlowDiagram;
export const createApiRequestFlowDiagram = apiRequestFlowDiagram;
export const createAuthenticationFlowDiagram = authenticationFlowDiagram;
