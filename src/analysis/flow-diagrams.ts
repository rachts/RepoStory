import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, ModuleRelationship } from "@/domain/finding";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { Repository } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { nowIso, opaqueId, stableId } from "@/shared/ids";
import { safePath, safeText, uniqueEvidence } from "@/analysis/static-utils";
import { redactPath } from "@/shared/redaction";

type FlowFinding = AnalysisFinding & Partial<ApiRouteFinding>;

function routeFindings(findings: readonly AnalysisFinding[], budget?: AnalysisBudget): ApiRouteFinding[] {
  const routes: ApiRouteFinding[] = [];
  for (const finding of findings) {
    budget?.check();
    if ((finding.kind === "api-route" || finding.kind === "route") && typeof (finding as FlowFinding).routePath === "string" && Array.isArray((finding as FlowFinding).methods) && typeof (finding as FlowFinding).filePath === "string") {
      routes.push(finding as ApiRouteFinding);
    }
  }
  routes.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return routes;
}

function meaningfulAuthFindings(findings: readonly AnalysisFinding[], budget?: AnalysisBudget): AuthenticationFinding[] {
  const authFindings: AuthenticationFinding[] = [];
  for (const finding of findings) {
    budget?.check();
    if (finding.kind === "authentication" && finding.evidence.length > 0 && finding.confidence !== "needs-verification") authFindings.push(finding as AuthenticationFinding);
  }
  authFindings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return authFindings;
}

function safeEvidence(evidence: AnalysisFinding["evidence"], budget?: AnalysisBudget): AnalysisFinding["evidence"] {
  const safe: AnalysisFinding["evidence"] = [];
  for (const item of evidence) {
    budget?.check();
    safe.push({ ...item, filePath: redactPath(safePath(item.filePath)), symbol: item.symbol ? safeText(item.symbol) : undefined, excerpt: item.excerpt ? safeText(item.excerpt) : undefined, reason: safeText(item.reason) });
  }
  return uniqueEvidence(safe, budget);
}

function fallbackEvidence(findings: readonly AnalysisFinding[], budget?: AnalysisBudget): NonNullable<AnalysisFinding["evidence"]> {
  const evidence: AnalysisFinding["evidence"] = [];
  for (const finding of findings) {
    budget?.check();
    for (const item of finding.evidence) {
      budget?.check();
      evidence.push(item);
    }
  }
  return safeEvidence(evidence, budget).slice(0, 3);
}

function nodeFromFinding(finding: AnalysisFinding, kind: DiagramNode["kind"], plainEnglishLabel = finding.plainEnglishLabel, budget?: AnalysisBudget): DiagramNode {
  return {
    id: finding.id,
    technicalLabel: safeText(finding.technicalLabel),
    plainEnglishLabel: safeText(plainEnglishLabel),
    explanation: safeText(finding.explanation),
    technicalDetail: finding.technicalDetail ? safeText(finding.technicalDetail) : undefined,
    kind,
    visible: true,
    confidence: finding.confidence,
    evidence: safeEvidence(finding.evidence, budget),
  };
}

function edge(idParts: string[], source: string, target: string, label: string, explanation: string, evidence: AnalysisFinding["evidence"], confidence: AnalysisFinding["confidence"], budget?: AnalysisBudget): DiagramEdge {
  return {
    id: stableId("flow-edge", ...idParts),
    source,
    target,
    label: safeText(label),
    explanation: safeText(explanation),
    visible: true,
    inferred: confidence !== "high",
    confidence,
    evidence: safeEvidence(evidence, budget),
  };
}

/** Build a conservative request flow from API route, module, database, and integration findings. */
export function apiRequestFlowDiagram(analysisId: string, repository: Repository, findings: readonly AnalysisFinding[], relationships: readonly ModuleRelationship[] = [], budget?: AnalysisBudget): Diagram | null {
  budget?.check();
  const routes = routeFindings(findings, budget);
  if (!routes.length) return null;
  const databases: AnalysisFinding[] = [];
  const integrations: AnalysisFinding[] = [];
  for (const finding of findings) {
    budget?.check();
    if (finding.kind === "database" || finding.kind === "database-client") databases.push(finding);
    if (finding.kind === "external-service" || finding.kind === "integration") integrations.push(finding);
  }
  databases.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  integrations.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  const evidence = fallbackEvidence(routes, budget);
  if (!evidence.length) return null;
  const createdAt = nowIso();
  const repositoryName = safeText(repository.name);
  let allRoutesHigh = true;
  for (const route of routes) {
    budget?.check();
    if (route.confidence !== "high") allRoutesHigh = false;
  }
  const applicationNode: DiagramNode = {
    id: "request-app",
    technicalLabel: repositoryName,
    plainEnglishLabel: "Application request handler",
    explanation: "The repository contains the code that receives and processes HTTP requests.",
    kind: "backend",
    visible: true,
    confidence: allRoutesHigh ? "high" : "medium",
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
  const routeNodes: DiagramNode[] = [];
  for (const route of routes) {
    budget?.check();
    routeNodes.push(nodeFromFinding(route, "api", `${route.methods.join(", ")} ${route.routePath}`, budget));
  }

  const relatedRelationships: ModuleRelationship[] = [];
  for (const relationship of relationships) {
    budget?.check();
    let matchesRoute = false;
    for (const route of routes) {
      budget?.check();
      if (route.filePath === relationship.sourceFile || route.filePath === relationship.source) {
        matchesRoute = true;
        break;
      }
    }
    if (matchesRoute) relatedRelationships.push(relationship);
  }
  relatedRelationships.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  const moduleNodes = new Map<string, DiagramNode>();
  for (const relationship of relatedRelationships) {
    budget?.check();
    if (moduleNodes.has(relationship.targetFile)) continue;
    moduleNodes.set(relationship.targetFile, {
      id: stableId("module-node", relationship.targetFile),
       technicalLabel: redactPath(safePath(relationship.targetFile)),
       plainEnglishLabel: `Module used by ${redactPath(safePath(relationship.sourceFile))}`,
       explanation: safeText(relationship.explanation),
      kind: "file",
      visible: true,
      confidence: relationship.confidence,
      evidence: safeEvidence(relationship.evidence, budget),
    });
  }

  const databaseNodes: DiagramNode[] = [];
  for (const finding of databases) {
    budget?.check();
    databaseNodes.push(nodeFromFinding(finding, "database", undefined, budget));
  }
  const integrationNodes: DiagramNode[] = [];
  for (const finding of integrations) {
    budget?.check();
    integrationNodes.push(nodeFromFinding(finding, "service", undefined, budget));
  }
  const nodes: DiagramNode[] = [userNode, applicationNode, ...routeNodes, ...moduleNodes.values(), ...databaseNodes, ...integrationNodes];
  const edges: DiagramEdge[] = [edge(["request-user", "request-app"], "request-user", "request-app", "sends request", "The request enters the analyzed application.", evidence, "medium", budget)];
  for (const route of routes) {
    budget?.check();
    edges.push(edge(["request-app", route.id], "request-app", route.id, "dispatches", `The application exposes ${route.methods.join(", ")} at ${route.routePath}.`, route.evidence, route.confidence, budget));
  }
  for (const relationship of relatedRelationships) {
    budget?.check();
    const moduleId = stableId("module-node", relationship.targetFile);
    let route: ApiRouteFinding | undefined;
    for (const candidate of routes) {
      budget?.check();
      if (candidate.filePath === relationship.sourceFile || candidate.filePath === relationship.source) {
        route = candidate;
        break;
      }
    }
    if (route) edges.push(edge([route.id, moduleId], route.id, moduleId, "imports", `The endpoint file imports ${redactPath(safePath(relationship.targetFile))}.`, relationship.evidence, relationship.confidence, budget));
  }
  for (const finding of databases) {
    budget?.check();
    edges.push(edge(["request-app", finding.id], "request-app", finding.id, "uses database evidence", "Static database evidence is present in the repository.", finding.evidence, finding.confidence, budget));
  }
  for (const finding of integrations) {
    budget?.check();
    edges.push(edge(["request-app", finding.id], "request-app", finding.id, "calls service evidence", "Static client or dependency evidence indicates an external service integration.", finding.evidence, finding.confidence, budget));
  }
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
  const authFindings = meaningfulAuthFindings(findings, budget);
  if (!authFindings.length) return null;
  const routes = routeFindings(findings, budget);
  const evidence = fallbackEvidence(authFindings, budget);
  if (!evidence.length) return null;
  const createdAt = nowIso();
  const repositoryName = safeText(repository.name);
  let allAuthFindingsHigh = true;
  for (const finding of authFindings) {
    budget?.check();
    if (finding.confidence !== "high") allAuthFindingsHigh = false;
  }
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
    confidence: allAuthFindingsHigh ? "high" : "medium",
    evidence,
  };
  const providerNodes: DiagramNode[] = [];
  for (const finding of authFindings) {
    budget?.check();
    providerNodes.push(nodeFromFinding(finding, finding.mechanism === "middleware" ? "backend" : "service", finding.provider, budget));
  }
  const tokenFindings: AuthenticationFinding[] = [];
  const tokenProviders: string[] = [];
  const tokenEvidence: AnalysisFinding["evidence"] = [];
  let allTokenFindingsHigh = true;
  for (const finding of authFindings) {
    budget?.check();
    if (finding.mechanism !== "jwt" && finding.mechanism !== "session") continue;
    tokenFindings.push(finding);
    tokenProviders.push(finding.provider);
    if (finding.confidence !== "high") allTokenFindingsHigh = false;
    for (const item of finding.evidence) {
      budget?.check();
      tokenEvidence.push(item);
    }
  }
  const tokenNode = tokenFindings.length ? {
    id: "auth-session-token",
    technicalLabel: tokenProviders.join(" / "),
    plainEnglishLabel: "Session or token state",
    explanation: "The repository contains evidence of session or token state used after authentication.",
    kind: "service" as const,
    visible: true,
    confidence: allTokenFindingsHigh ? "high" as const : "medium" as const,
    evidence: safeEvidence(tokenEvidence, budget),
  } : null;
  const routeNodes: DiagramNode[] = [];
  for (const route of routes) {
    budget?.check();
    routeNodes.push(nodeFromFinding(route, "api", `Detected endpoint ${route.routePath}`, budget));
  }
  const relatedRelationships: ModuleRelationship[] = [];
  for (const relationship of relationships) {
    budget?.check();
    let matchesAuth = false;
    for (const finding of authFindings) {
      budget?.check();
      for (const item of finding.evidence) {
        budget?.check();
        if (item.filePath === relationship.sourceFile || item.filePath === relationship.source) {
          matchesAuth = true;
          break;
        }
      }
      if (matchesAuth) break;
    }
    if (matchesAuth) relatedRelationships.push(relationship);
  }
  relatedRelationships.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  const moduleNodes: DiagramNode[] = [];
  const moduleIds = new Set<string>();
  for (const relationship of relatedRelationships) {
    budget?.check();
    const id = stableId("auth-module", relationship.targetFile);
    if (moduleIds.has(id)) continue;
    moduleIds.add(id);
    moduleNodes.push({ id, technicalLabel: redactPath(safePath(relationship.targetFile)), plainEnglishLabel: "Authentication-related module", explanation: safeText(relationship.explanation), kind: "file", visible: true, confidence: relationship.confidence, evidence: safeEvidence(relationship.evidence, budget) });
  }
  const nodes = [userNode, appNode, ...providerNodes, ...(tokenNode ? [tokenNode] : []), ...moduleNodes, ...routeNodes];
  const edges: DiagramEdge[] = [edge(["auth-user", "auth-app"], "auth-user", "auth-app", "requests access", "The user or client presents a request that the application must evaluate.", evidence, "medium", budget)];
  for (const finding of authFindings) {
    budget?.check();
    edges.push(edge(["auth-user", finding.id], "auth-user", finding.id, finding.mechanism === "oauth" ? "authorizes with" : "authenticates with", `Static evidence identifies ${finding.provider} as part of the authentication boundary.`, finding.evidence, finding.confidence, budget));
    edges.push(edge([finding.id, "auth-app"], finding.id, "auth-app", "returns identity signal", `${finding.provider} evidence contributes an identity, token, session, or middleware check.`, finding.evidence, finding.confidence, budget));
  }
  if (tokenNode) {
    budget?.check();
    edges.push(edge(["auth-app", tokenNode.id], "auth-app", tokenNode.id, "reads or issues", "The application uses the detected session or token mechanism.", tokenNode.evidence, tokenNode.confidence, budget));
  }
  for (const node of moduleNodes) {
    budget?.check();
    let relationship: ModuleRelationship | undefined;
    for (const candidate of relatedRelationships) {
      budget?.check();
      if (stableId("auth-module", candidate.targetFile) === node.id) {
        relationship = candidate;
        break;
      }
    }
    if (relationship) edges.push(edge(["auth-app", node.id], "auth-app", node.id, "uses auth module", "An authentication-related module is connected to the detected auth evidence.", relationship.evidence, relationship.confidence, budget));
  }
  for (const route of routes) {
    budget?.check();
    edges.push(edge(["auth-app", route.id], "auth-app", route.id, "may evaluate", `The repository contains authentication evidence and an endpoint at ${route.routePath}; static analysis cannot prove that this endpoint is protected.`, [...evidence, ...route.evidence], "needs-verification", budget));
  }
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
