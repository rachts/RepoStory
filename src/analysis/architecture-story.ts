import type {
  ArchitectureActor,
  ArchitectureActorKind,
  ArchitectureLayer,
  ArchitectureLayerKind,
  ArchitectureRelationship,
  ArchitectureRelationshipKind,
  ArchitectureRelationshipVerification,
  ArchitectureStep,
  ArchitectureStepKind,
  ArchitectureStory,
  ArchitectureStoryCoverage,
  ArchitectureStoryDiagramAvailability,
} from "@/domain/architecture-story";
import type { Diagram, DiagramNode, DiagramEdge, DiagramType } from "@/domain/diagram";
import type { EvidenceReference } from "@/domain/evidence";
import type { AnalysisFinding, ConfidenceLevel } from "@/domain/finding";
import type { Repository } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { uniqueEvidence } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";

export interface ArchitectureStoryInput {
  repository?: Pick<Repository, "id" | "name">;
  findings: readonly AnalysisFinding[];
  diagrams: readonly Diagram[];
  diagramAvailability?: readonly ArchitectureStoryDiagramAvailability[];
  filesAnalyzed?: number;
  filesDiscovered?: number;
  filesSkipped?: number;
  bytesAnalyzed?: number;
  bytesDiscovered?: number;
  bytesSkipped?: number;
}

const DIAGRAM_ORDER: Record<DiagramType, number> = {
  "repository-structure": 0,
  "system-overview": 1,
  "api-request-flow": 2,
  "authentication-flow": 3,
};

const LAYER_ORDER: Record<ArchitectureLayerKind, number> = {
  repository: 0,
  client: 1,
  application: 2,
  request: 3,
  identity: 4,
  module: 5,
  data: 6,
  "external-service": 7,
};

const DIAGRAM_TYPES: readonly DiagramType[] = [
  "repository-structure",
  "system-overview",
  "api-request-flow",
  "authentication-flow",
];

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
  "needs-verification": 3,
};

interface NodeRecord {
  key: string;
  node: DiagramNode;
  finding?: AnalysisFinding;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceNodeIds: string[];
  sourceDiagramTypes: DiagramType[];
  findingIds: string[];
  firstDiagramOrder: number;
  isActor: boolean;
  actorKind?: ArchitectureActorKind;
  stepKind?: ArchitectureStepKind;
  layerKind: ArchitectureLayerKind;
}

interface RelationshipRecord {
  key: string;
  source: NodeRecord;
  target: NodeRecord;
  edge: DiagramEdge;
  kind: ArchitectureRelationshipKind;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceEdgeIds: string[];
  sourceDiagramTypes: DiagramType[];
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortDiagramTypes(types: Iterable<DiagramType>): DiagramType[] {
  return [...new Set(types)].sort((left, right) => DIAGRAM_ORDER[left] - DIAGRAM_ORDER[right] || compareStrings(left, right));
}

function sortIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareStrings);
}

function weakestConfidence(values: readonly ConfidenceLevel[]): ConfidenceLevel {
  let weakest: ConfidenceLevel = "high";
  for (const value of values) {
    if (CONFIDENCE_ORDER[value] > CONFIDENCE_ORDER[weakest]) weakest = value;
  }
  return weakest;
}

function nonNegativeSafeInteger(value: number | undefined, fallback = 0): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? value! : fallback;
}

function mergeConfidence(left: ConfidenceLevel, right: ConfidenceLevel): ConfidenceLevel {
  return weakestConfidence([left, right]);
}

function cleanLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function findingMap(findings: readonly AnalysisFinding[]): Map<string, AnalysisFinding> {
  const sorted = [...findings].sort((left, right) => compareStrings(left.id, right.id));
  const byId = new Map<string, AnalysisFinding>();
  for (const finding of sorted) if (!byId.has(finding.id)) byId.set(finding.id, finding);
  return byId;
}

function canonicalNodeKey(diagram: Diagram, node: DiagramNode, finding: AnalysisFinding | undefined, repositoryName: string): string {
  if (node.kind === "person") return "actor:person";
  if (finding) return `finding:${finding.id}`;
  if (node.id === "repo") return `repository:${cleanLabel(node.technicalLabel)}`;
  if (node.id === "app" || node.id === "request-app" || node.id === "auth-app") return `application:${cleanLabel(repositoryName || node.technicalLabel)}`;
  if (node.kind === "frontend" || node.kind === "backend") return `application:${cleanLabel(node.technicalLabel)}`;
  if (node.kind === "file") return `module:${cleanLabel(node.technicalLabel)}`;
  if (node.kind === "directory") return `directory:${cleanLabel(node.technicalLabel)}`;
  if (node.kind === "database") return `database:${cleanLabel(node.technicalLabel)}`;
  if (node.kind === "api") return `api:${cleanLabel(node.technicalLabel)}`;
  if (node.kind === "service") return `${diagram.type === "authentication-flow" ? "identity" : "service"}:${cleanLabel(node.technicalLabel)}`;
  return `node:${node.kind}:${cleanLabel(node.technicalLabel)}:${node.id}`;
}

function stepKindFor(node: DiagramNode, finding: AnalysisFinding | undefined, diagramTypes: readonly DiagramType[]): ArchitectureStepKind {
  switch (finding?.kind) {
    case "api-route":
    case "route":
      return "api";
    case "authentication":
      return "authentication";
    case "database":
    case "database-client":
      return "database";
    case "external-service":
    case "integration":
      return "external-service";
    case "technology":
      return "technology";
    case "directory":
      return "directory";
    default:
      break;
  }

  if (node.kind === "api") return "api";
  if (node.kind === "database") return "database";
  if (node.kind === "file") return "module";
  if (node.kind === "directory") return "directory";
  if (node.kind === "frontend" || node.kind === "backend") return "application";
  if (node.kind === "service" && diagramTypes.includes("authentication-flow")) return "authentication";
  if (node.kind === "service") return "technology";
  return "application";
}

function layerForStep(stepKind: ArchitectureStepKind): ArchitectureLayerKind {
  switch (stepKind) {
    case "directory":
      return "repository";
    case "api":
      return "request";
    case "authentication":
      return "identity";
    case "module":
      return "module";
    case "database":
      return "data";
    case "external-service":
      return "external-service";
    case "application":
    case "technology":
      return "application";
  }
}

function layerForActor(actorKind: ArchitectureActorKind): ArchitectureLayerKind {
  switch (actorKind) {
    case "person":
    case "browser":
      return "client";
    case "database":
      return "data";
    case "external-service":
      return "external-service";
    case "frontend":
    case "backend":
      return "application";
  }
}

function layerCopy(kind: ArchitectureLayerKind): { technicalLabel: string; plainEnglishLabel: string; explanation: string } {
  switch (kind) {
    case "repository":
      return { technicalLabel: "repository-structure", plainEnglishLabel: "Repository structure", explanation: "Top-level repository areas supported by analyzed file evidence." };
    case "client":
      return { technicalLabel: "client", plainEnglishLabel: "People and clients", explanation: "People or clients represented by evidence-backed flow diagrams." };
    case "application":
      return { technicalLabel: "application", plainEnglishLabel: "Application foundation", explanation: "Application and technology signals supported by repository evidence." };
    case "request":
      return { technicalLabel: "request-handling", plainEnglishLabel: "Request handling", explanation: "Detected HTTP endpoints and the local request-handling path." };
    case "identity":
      return { technicalLabel: "identity-and-access", plainEnglishLabel: "Identity and access", explanation: "Authentication, session, token, and related module evidence." };
    case "module":
      return { technicalLabel: "local-modules", plainEnglishLabel: "Local modules", explanation: "Local files connected by evidence-backed import relationships." };
    case "data":
      return { technicalLabel: "data-storage", plainEnglishLabel: "Data storage", explanation: "Database or migration evidence found in the repository." };
    case "external-service":
      return { technicalLabel: "external-services", plainEnglishLabel: "External services", explanation: "Named external-service evidence found in the repository." };
  }
}

function actorKindFor(node: DiagramNode, finding: AnalysisFinding | undefined): ArchitectureActorKind | undefined {
  if (node.kind === "person") return "person";
  if (node.kind === "frontend") return "frontend";
  if (node.kind === "backend") return "backend";
  if (node.kind === "database") return "database";
  if (node.id === "system-external-service") return "external-service";
  if (node.kind === "service" && (finding?.kind === "external-service" || finding?.kind === "integration" || finding?.kind === "authentication")) return "external-service";
  return undefined;
}

function relationshipKind(label: string): ArchitectureRelationshipKind {
  const value = label.toLowerCase();
  if (value.includes("contain")) return "contains";
  if (value.includes("built with")) return "built-with";
  if (value.includes("dispatch")) return "dispatches";
  if (value.includes("import")) return "imports";
  if (value.includes("call")) return "calls";
  if (value.includes("authenticates") || value.includes("authenticate")) return "authenticates";
  if (value.includes("evaluat")) return "evaluates";
  if (value.includes("use") || value.includes("read") || value.includes("issue")) return "uses";
  return "connects";
}

function verificationFor(confidence: ConfidenceLevel, label: string, inferred: boolean): ArchitectureRelationshipVerification {
  if (confidence === "needs-verification" || /\b(?:may|might|possibly|uncertain|unconfirmed|unknown)\b/i.test(label)) return "needs-verification";
  if (inferred) return "inferred";
  if (confidence === "high") return "supported";
  return "inferred";
}

function relationshipLabel(label: string, verification: ArchitectureRelationshipVerification): string {
  const base = cleanLabel(label) || "connects";
  if (verification === "needs-verification") return `Needs verification: ${base}`;
  if (verification === "inferred") return `Inferred: ${base}`;
  return base;
}

function relationshipExplanation(edge: DiagramEdge, verification: ArchitectureRelationshipVerification): string {
  const explanation = cleanLabel(edge.explanation ?? "");
  if (verification === "needs-verification") return cleanLabel(`Static analysis could not confirm this connection. ${explanation}`);
  if (verification === "inferred") return cleanLabel(`This connection is inferred from static repository evidence. ${explanation}`);
  return explanation || "Static repository evidence supports this connection.";
}

function unavailableReason(type: DiagramType): string {
  switch (type) {
    case "system-overview":
      return "Not enough technology evidence was found.";
    case "api-request-flow":
      return "No evidence-backed API routes were detected.";
    case "authentication-flow":
      return "No meaningful authentication evidence was detected.";
    case "repository-structure":
      return "No repository structure diagram was generated.";
  }
}

function normalizeAvailability(input: ArchitectureStoryInput): ArchitectureStoryDiagramAvailability[] {
  const provided = new Map<DiagramType, ArchitectureStoryDiagramAvailability>();
  for (const item of input.diagramAvailability ?? []) if (!provided.has(item.type)) provided.set(item.type, item);
  const diagramTypes = new Set(input.diagrams.map((diagram) => diagram.type));
  return DIAGRAM_TYPES.map((type) => {
    const existing = provided.get(type);
    if (existing) return { ...existing, ...(existing.reason ? { reason: cleanLabel(existing.reason) } : {}) };
    return { type, available: diagramTypes.has(type), ...(diagramTypes.has(type) ? {} : { reason: unavailableReason(type) }) };
  });
}

function storyConfidence(actors: readonly ArchitectureActor[], steps: readonly ArchitectureStep[], layers: readonly ArchitectureLayer[], relationships: readonly ArchitectureRelationship[]): ConfidenceLevel {
  const values = [...actors, ...steps, ...layers, ...relationships].map((item) => item.confidence);
  return values.length ? weakestConfidence(values) : "needs-verification";
}

function elementEvidence(actors: readonly ArchitectureActor[], steps: readonly ArchitectureStep[], layers: readonly ArchitectureLayer[], relationships: readonly ArchitectureRelationship[]): EvidenceReference[] {
  return uniqueEvidence([
    ...actors.flatMap((actor) => actor.evidence),
    ...steps.flatMap((step) => step.evidence),
    ...layers.flatMap((layer) => layer.evidence),
    ...relationships.flatMap((relationship) => relationship.evidence),
  ]);
}

function hasWeakConfidence(actors: readonly ArchitectureActor[], steps: readonly ArchitectureStep[], layers: readonly ArchitectureLayer[], relationships: readonly ArchitectureRelationship[]): boolean {
  return [...actors, ...steps, ...layers, ...relationships].some((item) => item.confidence === "low" || item.confidence === "needs-verification");
}

function buildSummary(repositoryName: string, actors: readonly ArchitectureActor[], steps: readonly ArchitectureStep[], coverage: ArchitectureStoryCoverage): string {
  if (!actors.length && !steps.length) return "The repository does not provide enough evidence to describe how the application works.";

  const hasWebInterface = actors.some((actor) => actor.kind === "frontend" || actor.kind === "browser");
  const hasApplicationServer = actors.some((actor) => actor.kind === "backend") || steps.some((step) => step.kind === "api");
  const hasApiFlow = coverage.apiRequestFlowAvailable && steps.some((step) => step.kind === "api");
  const hasData = actors.some((actor) => actor.kind === "database") || steps.some((step) => step.kind === "database");
  const hasExternalService = actors.some((actor) => actor.kind === "external-service") || steps.some((step) => step.kind === "external-service");
  const hasAuthentication = steps.some((step) => step.kind === "authentication");
  const name = repositoryName && repositoryName !== "repository" ? `This ${repositoryName} application` : "This application";

  let summary: string;
  if (hasWebInterface && hasApplicationServer && hasApiFlow) {
    summary = `${name} appears to provide a web interface that sends requests to application handlers and returns results to the browser.`;
  } else if (hasWebInterface && !hasApiFlow) {
    summary = `${name} shows a web interface, but no clear API request flow was detected in the analyzed files.`;
  } else if (hasApplicationServer && hasApiFlow) {
    summary = `${name} shows server-side request handlers, but a browser interface was not confirmed in the analyzed files.`;
  } else if (hasWebInterface) {
    summary = `${name} shows a web interface, but the complete request path could not be confirmed from the analyzed files.`;
  } else {
    summary = `${name} contains application building blocks, but the complete user-facing flow could not be confirmed from the analyzed files.`;
  }

  const supportingEvidence: string[] = [];
  if (hasData) supportingEvidence.push("application data storage");
  if (hasExternalService) supportingEvidence.push("connected services");
  if (hasAuthentication) supportingEvidence.push("sign-in or access checks");
  if (supportingEvidence.length) summary += ` The repository also shows evidence of ${supportingEvidence.join(", ")}.`;
  if (coverage.partial) summary += " This explanation is based on a partial static view of the repository.";
  return cleanLabel(summary);
}

function buildTechnicalSummary(actors: readonly ArchitectureActor[], steps: readonly ArchitectureStep[]): string | undefined {
  const labels = [...actors.map((actor) => actor.technicalLabel), ...steps.map((step) => step.technicalLabel)]
    .filter(Boolean)
    .sort(compareStrings)
    .filter((label, index, all) => all[index - 1] !== label);
  return labels.length ? `Static findings represented in this story: ${labels.join(", ")}.` : undefined;
}

/**
 * Build a conservative architecture narrative from already-generated diagrams.
 * This function does not inspect repository files or infer a new system model.
 */
export function generateArchitectureStory(input: ArchitectureStoryInput, budget?: AnalysisBudget): ArchitectureStory {
  budget?.check();
  const repositoryName = input.repository?.name ?? "repository";
  const byFindingId = findingMap(input.findings);
  const sortedDiagrams = [...input.diagrams]
    .sort((left, right) => DIAGRAM_ORDER[left.type] - DIAGRAM_ORDER[right.type] || compareStrings(left.id, right.id));
  const records = new Map<string, NodeRecord>();
  const nodeKeys = new Map<string, string>();

  for (const diagram of sortedDiagrams) {
    budget?.check();
    const diagramOrder = DIAGRAM_ORDER[diagram.type];
    const nodes = [...diagram.nodes].sort((left, right) => compareStrings(left.id, right.id));
    for (const node of nodes) {
      budget?.check();
      const finding = byFindingId.get(node.id);
      const evidence = uniqueEvidence([...node.evidence, ...(finding?.evidence ?? [])]);
      const nodeRef = `${diagram.type}\u0000${node.id}`;
      if (!node.visible || !evidence.length) continue;
      const key = canonicalNodeKey(diagram, node, finding, repositoryName);
      const existing = records.get(key);
      if (existing) {
        existing.confidence = mergeConfidence(existing.confidence, finding ? mergeConfidence(node.confidence, finding.confidence) : node.confidence);
        existing.evidence = uniqueEvidence([...existing.evidence, ...evidence], budget);
        existing.sourceNodeIds = sortIds([...existing.sourceNodeIds, node.id]);
        existing.sourceDiagramTypes = sortDiagramTypes([...existing.sourceDiagramTypes, diagram.type]);
        if (finding && !existing.findingIds.includes(finding.id)) existing.findingIds = sortIds([...existing.findingIds, finding.id]);
        nodeKeys.set(nodeRef, key);
        continue;
      }

      const sourceDiagramTypes = [diagram.type];
       const actorKind = actorKindFor(node, finding);
       const isActor = Boolean(actorKind);
       const stepKind = isActor ? undefined : stepKindFor(node, finding, sourceDiagramTypes);
       const layerKind = isActor ? layerForActor(actorKind!) : layerForStep(stepKind!);
      records.set(key, {
        key,
        node,
        ...(finding ? { finding } : {}),
        confidence: finding ? mergeConfidence(node.confidence, finding.confidence) : node.confidence,
        evidence,
        sourceNodeIds: [node.id],
        sourceDiagramTypes,
        findingIds: finding ? [finding.id] : [],
        firstDiagramOrder: diagramOrder,
        isActor,
        ...(actorKind ? { actorKind } : {}),
        ...(stepKind ? { stepKind } : {}),
        layerKind,
      });
      nodeKeys.set(nodeRef, key);
    }
  }

  budget?.check();
  const actorRecords = [...records.values()]
    .filter((record): record is NodeRecord & { isActor: true; actorKind: ArchitectureActorKind } => record.isActor && Boolean(record.actorKind))
    .sort((left, right) => compareStrings(left.key, right.key));
  const stepRecords = [...records.values()]
    .filter((record): record is NodeRecord & { isActor: false; stepKind: ArchitectureStepKind } => !record.isActor && Boolean(record.stepKind))
    .sort((left, right) => LAYER_ORDER[left.layerKind] - LAYER_ORDER[right.layerKind] || compareStrings(left.node.technicalLabel, right.node.technicalLabel) || compareStrings(left.key, right.key));
  const narrativeStepRecords = stepRecords.filter((record) => ["api", "authentication", "database", "external-service", "application"].includes(record.stepKind));

  const actorIdFor = (record: NodeRecord): string => stableId("architecture-actor", record.key);
  const stepIdFor = (record: NodeRecord): string => stableId("architecture-step", record.key);
  const layerIdFor = (kind: ArchitectureLayerKind): string => stableId("architecture-layer", kind);

  const actors: ArchitectureActor[] = actorRecords.map((record) => ({
    id: actorIdFor(record),
    kind: record.actorKind,
    label: cleanLabel(record.node.technicalLabel),
    technicalLabel: cleanLabel(record.node.technicalLabel),
    plainEnglishLabel: cleanLabel(record.node.plainEnglishLabel || record.node.technicalLabel),
    explanation: cleanLabel(record.node.explanation),
    inferred: !record.findingIds.length,
    confidence: record.confidence,
    evidence: record.evidence,
    sourceNodeIds: sortIds(record.sourceNodeIds),
    sourceDiagramTypes: sortDiagramTypes(record.sourceDiagramTypes),
  }));

  const steps: ArchitectureStep[] = narrativeStepRecords.map((record, index) => ({
    id: stepIdFor(record),
    kind: record.stepKind,
    order: index + 1,
    layerId: layerIdFor(record.layerKind),
    title: cleanLabel(record.node.plainEnglishLabel || record.node.technicalLabel),
    plainEnglishTitle: cleanLabel(record.node.plainEnglishLabel || record.node.technicalLabel),
    technicalLabel: cleanLabel(record.node.technicalLabel),
    plainEnglishLabel: cleanLabel(record.node.plainEnglishLabel || record.node.technicalLabel),
    explanation: cleanLabel(record.node.explanation),
    technicalDetail: record.node.technicalDetail ? cleanLabel(record.node.technicalDetail) : undefined,
    confidence: record.confidence,
    evidence: record.evidence,
    sourceNodeIds: sortIds(record.sourceNodeIds),
    targetNodeIds: [],
    sourceDiagramTypes: sortDiagramTypes(record.sourceDiagramTypes),
  }));

  const relationshipsByKey = new Map<string, RelationshipRecord>();
  for (const diagram of sortedDiagrams) {
    budget?.check();
    const edges = [...diagram.edges].sort((left, right) => compareStrings(left.id, right.id));
    for (const edge of edges) {
      budget?.check();
      if (!edge.visible || !edge.evidence.length) continue;
      const sourceKey = nodeKeys.get(`${diagram.type}\u0000${edge.source}`);
      const targetKey = nodeKeys.get(`${diagram.type}\u0000${edge.target}`);
      const source = sourceKey ? records.get(sourceKey) : undefined;
      const target = targetKey ? records.get(targetKey) : undefined;
      if (!source || !target || source.key === target.key) continue;
      const kind = relationshipKind(edge.label);
      const key = `${source.key}\u0000${target.key}\u0000${kind}\u0000${cleanLabel(edge.label).toLowerCase()}`;
      const existing = relationshipsByKey.get(key);
      if (existing) {
        existing.confidence = weakestConfidence([existing.confidence, edge.confidence, source.confidence, target.confidence]);
        existing.evidence = uniqueEvidence([...existing.evidence, ...edge.evidence], budget);
        existing.sourceEdgeIds = sortIds([...existing.sourceEdgeIds, edge.id]);
        existing.sourceDiagramTypes = sortDiagramTypes([...existing.sourceDiagramTypes, diagram.type]);
        continue;
      }
      relationshipsByKey.set(key, {
        key,
        source,
        target,
        edge,
        kind,
        confidence: weakestConfidence([edge.confidence, source.confidence, target.confidence]),
        evidence: uniqueEvidence(edge.evidence, budget),
        sourceEdgeIds: [edge.id],
        sourceDiagramTypes: [diagram.type],
      });
    }
  }

  const actorByRecordKey = new Map(actorRecords.map((record) => [record.key, actorIdFor(record)]));
  const stepByRecordKey = new Map(narrativeStepRecords.map((record) => [record.key, stepIdFor(record)]));
  const elementIdFor = (record: NodeRecord): string | undefined => record.isActor ? actorByRecordKey.get(record.key) : stepByRecordKey.get(record.key);
  const elementLabelFor = (record: NodeRecord): string => cleanLabel(record.node.plainEnglishLabel || record.node.technicalLabel);

  const relationshipRecords = [...relationshipsByKey.values()]
    .filter((record): record is RelationshipRecord & { source: NodeRecord; target: NodeRecord } => Boolean(elementIdFor(record.source) && elementIdFor(record.target)))
    .sort((left, right) => {
      const sourceCompare = compareStrings(elementIdFor(left.source)!, elementIdFor(right.source)!);
      return sourceCompare || compareStrings(elementIdFor(left.target)!, elementIdFor(right.target)!) || compareStrings(left.key, right.key);
    });
  const relationships: ArchitectureRelationship[] = relationshipRecords.map((record) => {
    const sourceId = elementIdFor(record.source)!;
    const targetId = elementIdFor(record.target)!;
    const verification = verificationFor(record.confidence, record.edge.label, record.edge.inferred === true);
    const label = relationshipLabel(record.edge.label, verification);
    return {
      id: stableId("architecture-relationship", sourceId, targetId, record.kind, cleanLabel(record.edge.label)),
      sourceId,
      targetId,
      source: sourceId,
      target: targetId,
      sourceLabel: elementLabelFor(record.source),
      targetLabel: elementLabelFor(record.target),
      kind: record.kind,
      relationship: record.kind,
      label,
      plainEnglishLabel: label,
      explanation: relationshipExplanation(record.edge, verification),
      inferred: verification !== "supported",
      verification,
      confidence: record.confidence,
      evidence: record.evidence,
      sourceEdgeIds: sortIds(record.sourceEdgeIds),
      sourceDiagramTypes: sortDiagramTypes(record.sourceDiagramTypes),
    };
  });

  for (const record of relationshipRecords) {
    budget?.check();
    if (record.source.isActor) continue;
    const sourceStepId = stepByRecordKey.get(record.source.key);
    const sourceStep = steps.find((step) => step.id === sourceStepId);
    if (!sourceStep) continue;
    sourceStep.targetNodeIds = sortIds([...sourceStep.targetNodeIds, ...record.target.sourceNodeIds]);
  }

  const elementOrder = new Map<string, number>();
  actors.forEach((actor, index) => elementOrder.set(actor.id, index));
  steps.forEach((step, index) => elementOrder.set(step.id, actors.length + index));
  relationships.sort((left, right) => elementOrder.get(left.sourceId)! - elementOrder.get(right.sourceId)! || elementOrder.get(left.targetId)! - elementOrder.get(right.targetId)! || compareStrings(left.id, right.id));

  const layerKinds = new Set<ArchitectureLayerKind>();
  for (const record of records.values()) layerKinds.add(record.layerKind);
  const layers: ArchitectureLayer[] = [...layerKinds]
     .sort((left, right) => LAYER_ORDER[left] - LAYER_ORDER[right] || compareStrings(left, right))
     .map((kind, index) => {
       const layerId = layerIdFor(kind);
       const layerRecords = [...records.values()].filter((record) => record.layerKind === kind);
       const layerActorIds = actorRecords.filter((record) => record.layerKind === kind).map(actorIdFor).sort(compareStrings);
       const layerStepIds = narrativeStepRecords.filter((record) => record.layerKind === kind).map(stepIdFor).sort(compareStrings);
       const layerRelationshipIds = relationships
         .filter((relationship) => layerActorIds.includes(relationship.sourceId) || layerActorIds.includes(relationship.targetId) || layerStepIds.includes(relationship.sourceId) || layerStepIds.includes(relationship.targetId))
         .map((relationship) => relationship.id)
         .sort(compareStrings);
       const layerMembers = [
         ...actors.filter((actor) => layerActorIds.includes(actor.id)),
         ...steps.filter((step) => layerStepIds.includes(step.id)),
         ...relationships.filter((relationship) => layerRelationshipIds.includes(relationship.id)),
       ];
       const copy = layerCopy(kind);
        const layerEvidence = uniqueEvidence([
          ...layerRecords.flatMap((record) => record.evidence),
          ...layerMembers.flatMap((member) => member.evidence),
        ], budget);
       const layerConfidence = weakestConfidence([
         ...layerRecords.map((record) => record.confidence),
         ...layerMembers.map((member) => member.confidence),
       ]);
       const layerSourceDiagramTypes = sortDiagramTypes([
         ...layerRecords.flatMap((record) => record.sourceDiagramTypes),
         ...layerMembers.flatMap((member) => member.sourceDiagramTypes),
       ]);
        return {
         id: layerId,
         kind,
         order: index + 1,
         label: copy.technicalLabel,
         technicalLabel: copy.technicalLabel,
         plainEnglishLabel: copy.plainEnglishLabel,
         purpose: copy.explanation,
         explanation: copy.explanation,
         nodeIds: sortIds(layerRecords.flatMap((record) => record.sourceNodeIds)),
         actorIds: layerActorIds,
         stepIds: layerStepIds,
         relationshipIds: layerRelationshipIds,
         confidence: layerConfidence,
         evidence: layerEvidence,
         sourceDiagramTypes: layerSourceDiagramTypes,
       };
     });

  const availability = normalizeAvailability(input);
  const availableDiagramTypes = availability.filter((item) => item.available).map((item) => item.type);
  const unavailableDiagramTypes = availability.filter((item) => !item.available);
  const availabilityByType = new Map(availability.map((item) => [item.type, item]));
  const repositoryStructureAvailable = availabilityByType.get("repository-structure")?.available ?? false;
  const systemOverviewAvailable = availabilityByType.get("system-overview")?.available ?? false;
  const apiRequestFlowAvailable = availabilityByType.get("api-request-flow")?.available ?? false;
  const authenticationFlowAvailable = availabilityByType.get("authentication-flow")?.available ?? false;
  const hasElements = actors.length > 0 || steps.length > 0 || layers.length > 0 || relationships.length > 0;
  const status = !hasElements ? "empty" : systemOverviewAvailable && apiRequestFlowAvailable ? "complete" : systemOverviewAvailable || apiRequestFlowAvailable ? "partial" : "limited";
  const filesAnalyzed = Number.isSafeInteger(input.filesAnalyzed) && (input.filesAnalyzed ?? 0) >= 0 ? input.filesAnalyzed! : 0;
  const discoveredFiles = Number.isSafeInteger(input.filesDiscovered) && (input.filesDiscovered ?? 0) >= filesAnalyzed ? input.filesDiscovered! : filesAnalyzed;
  const filesSkipped = Math.min(discoveredFiles, nonNegativeSafeInteger(input.filesSkipped, discoveredFiles - filesAnalyzed));
  const bytesAnalyzed = nonNegativeSafeInteger(input.bytesAnalyzed);
  const bytesDiscovered = Math.max(bytesAnalyzed, nonNegativeSafeInteger(input.bytesDiscovered, bytesAnalyzed + nonNegativeSafeInteger(input.bytesSkipped)));
  const bytesSkipped = Math.max(0, bytesDiscovered - bytesAnalyzed);
  const fileCoverageIsPartial = filesSkipped > 0 || discoveredFiles > filesAnalyzed;
  const coverageIsPartial = status === "partial" || status === "limited" || fileCoverageIsPartial;
  const caveats: string[] = [];

  if (fileCoverageIsPartial) caveats.push(`Only ${filesAnalyzed} of ${discoveredFiles} discovered files were analyzed, so this story has partial repository coverage.`);
  for (const item of unavailableDiagramTypes) {
    const label = item.type === "system-overview" ? "System overview" : item.type === "api-request-flow" ? "API request flow" : item.type === "authentication-flow" ? "Authentication flow" : "Repository structure";
    caveats.push(`${label} is unavailable: ${item.reason ?? unavailableReason(item.type)}`);
  }
  if (hasWeakConfidence(actors, steps, layers, relationships)) caveats.push("Some architecture elements have low or needs-verification confidence; confirm them against the cited evidence.");
  if (!hasElements) caveats.push("No evidence-backed actors, steps, layers, or relationships were found.");

  const coverage: ArchitectureStory["coverage"] = {
    status,
    partial: coverageIsPartial,
    filesAnalyzed,
    filesDiscovered: discoveredFiles,
    analyzedFiles: filesAnalyzed,
    discoveredFiles,
    filesSkipped,
    bytesAnalyzed,
    bytesDiscovered,
    bytesSkipped,
    evidenceBackedFindings: input.findings.filter((finding) => finding.evidence.length > 0).length,
    evidenceBackedElements: actors.length + steps.length + layers.length + relationships.length,
    availableDiagramTypes: sortDiagramTypes(availableDiagramTypes),
    unavailableDiagramTypes: unavailableDiagramTypes.map((item) => ({ ...item })),
    diagramAvailability: availability.map((item) => ({ ...item })),
    repositoryStructureAvailable,
    systemOverviewAvailable,
    apiRequestFlowAvailable,
    authenticationFlowAvailable,
    caveats: [...caveats],
  };
  const summary = buildSummary(repositoryName, actors, steps, coverage);
  const technicalSummary = buildTechnicalSummary(actors, steps);
  const story: ArchitectureStory = {
    id: stableId("architecture-story", input.repository?.id ?? repositoryName),
    headline: repositoryName && repositoryName !== "repository" ? `How ${repositoryName} works` : "How this application works",
    summary,
    plainEnglishSummary: summary,
    ...(technicalSummary ? { technicalSummary } : {}),
    confidence: storyConfidence(actors, steps, layers, relationships),
    evidence: elementEvidence(actors, steps, layers, relationships),
    actors,
    steps,
    layers,
    relationships,
    coverage,
    caveats,
  };
  budget?.check();
  return story;
}

export const createArchitectureStory = generateArchitectureStory;
export const architectureStory = generateArchitectureStory;
