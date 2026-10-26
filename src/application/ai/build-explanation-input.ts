import type { AnalysisJob } from "@/domain/analysis";
import type { ArchitectureActor, ArchitectureLayer, ArchitectureRelationship, ArchitectureStep, ArchitectureStory } from "@/domain/architecture-story";
import type { Diagram, DiagramEdge, DiagramNode } from "@/domain/diagram";
import type { EvidenceReference } from "@/domain/evidence";
import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, DatabaseFinding, ExternalIntegrationFinding, ModuleRelationship } from "@/domain/finding";
import { redactPath, redactSecrets } from "@/shared/redaction";

export interface ExplanationEvidence {
  id: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  reason: string;
  excerpt?: string;
}

export interface ExplanationFinding {
  id: string;
  kind: string;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  confidence: string;
  evidenceIds: string[];
  evidence: ExplanationEvidence[];
}

export interface ExplanationInputPayload {
  repository: { owner: string; name: string; branch: string };
  architectureStory: {
    summary: string;
    confidence: string;
    caveats: string[];
    coverage: {
      status: string;
      filesAnalyzed: number;
      filesDiscovered: number;
      evidenceBackedFindings: number;
      availableDiagramTypes: string[];
    };
    actors: Array<{
      id: string;
      kind: string;
      technicalLabel: string;
      plainEnglishLabel: string;
      explanation: string;
      inferred: boolean;
      confidence: string;
      evidenceIds: string[];
      evidence: ExplanationEvidence[];
    }>;
    steps: Array<{
      id: string;
      kind: string;
      order: number;
      layerId: string;
      technicalLabel: string;
      plainEnglishLabel: string;
      explanation: string;
      technicalDetail?: string;
      confidence: string;
      evidenceIds: string[];
      evidence: ExplanationEvidence[];
      targetNodeIds: string[];
      sourceDiagramTypes: string[];
    }>;
    layers: Array<{
      id: string;
      kind: string;
      order: number;
      technicalLabel: string;
      plainEnglishLabel: string;
      purpose: string;
      explanation: string;
      confidence: string;
      evidenceIds: string[];
      evidence: ExplanationEvidence[];
      sourceDiagramTypes: string[];
    }>;
    relationships: Array<{
      id: string;
      sourceId: string;
      targetId: string;
      sourceLabel: string;
      targetLabel: string;
      kind: string;
      label: string;
      plainEnglishLabel: string;
      explanation: string;
      inferred: boolean;
      verification: string;
      confidence: string;
      evidenceIds: string[];
      evidence: ExplanationEvidence[];
      sourceDiagramTypes: string[];
    }>;
  };
  technologies: ExplanationFinding[];
  directories: ExplanationFinding[];
  entryPoints: ExplanationFinding[];
  apiRoutes: Array<{
    id: string;
    route: string;
    methods: string[];
    framework: string;
    filePath: string;
    explanation: string;
    confidence: string;
    evidenceIds: string[];
    evidence: ExplanationEvidence[];
  }>;
  authentication: ExplanationFinding[];
  databases: ExplanationFinding[];
  externalIntegrations: ExplanationFinding[];
  moduleRelationships: Array<{
    id: string;
    sourceFile: string;
    targetFile: string;
    specifier: string;
    importType: string;
    confidence: string;
    evidenceIds: string[];
    evidence: ExplanationEvidence[];
  }>;
  diagrams: Array<{
    type: string;
    title: string;
    description: string;
    nodes: Array<{
      id: string;
      label: string;
      plainEnglishLabel: string;
      kind: string;
      confidence: string;
      evidenceIds: string[];
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      label: string;
      inferred: boolean;
      confidence: string;
      evidenceIds: string[];
    }>;
  }>;
  truncation: { truncated: boolean; omittedSections: string[] };
}

export interface ExplanationInputResult {
  payload: ExplanationInputPayload;
  serialized: string;
  truncated: boolean;
}

export function collectExplanationEvidenceIds(payload: ExplanationInputPayload): Set<string> {
  const ids = new Set<string>();
  const add = (items: readonly { evidenceIds: readonly string[] }[]): void => {
    for (const item of items) for (const id of item.evidenceIds) ids.add(id);
  };
  add(payload.technologies);
  add(payload.directories);
  add(payload.entryPoints);
  add(payload.apiRoutes);
  add(payload.authentication);
  add(payload.databases);
  add(payload.externalIntegrations);
  add(payload.moduleRelationships);
  add(payload.architectureStory.actors);
  add(payload.architectureStory.steps);
  add(payload.architectureStory.layers);
  add(payload.architectureStory.relationships);
  for (const diagram of payload.diagrams) {
    add(diagram.nodes);
    add(diagram.edges);
  }
  return ids;
}

const DEFAULT_MAX_INPUT_CHARS = 60_000;
const MAX_EVIDENCE_PER_ITEM = 6;
const MAX_EXCERPT_CHARS = 500;

function clip(value: string | undefined, max: number): string {
  const safe = redactSecrets(redactPath(value ?? "")).trim();
  return safe.length <= max ? safe : `${safe.slice(0, Math.max(0, max - 1))}…`;
}

function safeEvidence(evidence: readonly EvidenceReference[] | undefined): ExplanationEvidence[] {
  return (evidence ?? []).slice(0, MAX_EVIDENCE_PER_ITEM).map((item) => ({
    id: clip(item.id, 256),
    filePath: clip(item.filePath, 500),
    ...(item.lineStart === undefined ? {} : { lineStart: item.lineStart }),
    ...(item.lineEnd === undefined ? {} : { lineEnd: item.lineEnd }),
    reason: clip(item.reason, 500),
    ...(item.excerpt ? { excerpt: clip(item.excerpt, MAX_EXCERPT_CHARS) } : {}),
  }));
}

function evidenceIds(evidence: readonly ExplanationEvidence[]): string[] {
  return evidence.map((item) => item.id).filter(Boolean);
}

function safeFinding(finding: AnalysisFinding): ExplanationFinding {
  const evidence = safeEvidence(finding.evidence);
  return {
    id: clip(finding.id, 256),
    kind: clip(finding.kind, 80),
    technicalLabel: clip(finding.technicalLabel, 300),
    plainEnglishLabel: clip(finding.plainEnglishLabel, 300),
    explanation: clip(finding.explanation, 1_200),
    ...(finding.technicalDetail ? { technicalDetail: clip(finding.technicalDetail, 1_200) } : {}),
    confidence: finding.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
  };
}

function safeApiRoute(route: ApiRouteFinding) {
  const evidence = safeEvidence(route.evidence);
  return {
    id: clip(route.id, 256),
    route: clip(route.routePath || route.route || route.path, 500),
    methods: route.methods.slice(0, 12),
    framework: clip(route.framework, 100),
    filePath: clip(route.filePath, 500),
    explanation: clip(route.explanation, 1_200),
    confidence: route.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
  };
}

function safeModuleRelationship(relationship: ModuleRelationship) {
  const evidence = safeEvidence(relationship.evidence);
  return {
    id: clip(relationship.id, 256),
    sourceFile: clip(relationship.sourceFile || relationship.sourcePath || relationship.source, 500),
    targetFile: clip(relationship.targetFile || relationship.targetPath || relationship.target, 500),
    specifier: clip(relationship.specifier, 300),
    importType: relationship.importType,
    confidence: relationship.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
  };
}

function safeDiagramNode(node: DiagramNode) {
  const evidence = safeEvidence(node.evidence);
  return {
    id: clip(node.id, 256),
    label: clip(node.technicalLabel, 300),
    plainEnglishLabel: clip(node.plainEnglishLabel, 300),
    kind: node.kind,
    confidence: node.confidence,
    evidenceIds: evidenceIds(evidence),
  };
}

function safeDiagramEdge(edge: DiagramEdge) {
  const evidence = safeEvidence(edge.evidence);
  return {
    id: clip(edge.id, 256),
    source: clip(edge.source, 256),
    target: clip(edge.target, 256),
    label: clip(edge.label, 300),
    inferred: Boolean(edge.inferred),
    confidence: edge.confidence,
    evidenceIds: evidenceIds(evidence),
  };
}

function safeDiagram(diagram: Diagram) {
  return {
    type: diagram.type,
    title: clip(diagram.title, 300),
    description: clip(diagram.description, 1_000),
    nodes: diagram.nodes.slice(0, 80).map(safeDiagramNode),
    edges: diagram.edges.slice(0, 120).map(safeDiagramEdge),
  };
}

function safeArchitectureActor(actor: ArchitectureActor) {
  const evidence = safeEvidence(actor.evidence);
  return {
    id: clip(actor.id, 256),
    kind: clip(actor.kind, 80),
    technicalLabel: clip(actor.technicalLabel, 300),
    plainEnglishLabel: clip(actor.plainEnglishLabel, 300),
    explanation: clip(actor.explanation, 1_200),
    inferred: Boolean(actor.inferred),
    confidence: actor.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
  };
}

function safeArchitectureStep(step: ArchitectureStep) {
  const evidence = safeEvidence(step.evidence);
  return {
    id: clip(step.id, 256),
    kind: clip(step.kind, 80),
    order: step.order,
    layerId: clip(step.layerId, 256),
    technicalLabel: clip(step.technicalLabel, 300),
    plainEnglishLabel: clip(step.plainEnglishLabel, 300),
    explanation: clip(step.explanation, 1_200),
    ...(step.technicalDetail ? { technicalDetail: clip(step.technicalDetail, 1_200) } : {}),
    confidence: step.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
    targetNodeIds: step.targetNodeIds.slice(0, 30).map((id) => clip(id, 256)),
    sourceDiagramTypes: step.sourceDiagramTypes.slice(0, 8),
  };
}

function safeArchitectureLayer(layer: ArchitectureLayer) {
  const evidence = safeEvidence(layer.evidence);
  return {
    id: clip(layer.id, 256),
    kind: clip(layer.kind, 80),
    order: layer.order,
    technicalLabel: clip(layer.technicalLabel, 300),
    plainEnglishLabel: clip(layer.plainEnglishLabel, 300),
    purpose: clip(layer.purpose, 1_000),
    explanation: clip(layer.explanation, 1_000),
    confidence: layer.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
    sourceDiagramTypes: layer.sourceDiagramTypes.slice(0, 8),
  };
}

function safeArchitectureRelationship(relationship: ArchitectureRelationship) {
  const evidence = safeEvidence(relationship.evidence);
  return {
    id: clip(relationship.id, 256),
    sourceId: clip(relationship.sourceId, 256),
    targetId: clip(relationship.targetId, 256),
    sourceLabel: clip(relationship.sourceLabel, 300),
    targetLabel: clip(relationship.targetLabel, 300),
    kind: clip(relationship.kind, 80),
    label: clip(relationship.label, 300),
    plainEnglishLabel: clip(relationship.plainEnglishLabel, 300),
    explanation: clip(relationship.explanation, 1_200),
    inferred: Boolean(relationship.inferred),
    verification: relationship.verification,
    confidence: relationship.confidence,
    evidenceIds: evidenceIds(evidence),
    evidence,
    sourceDiagramTypes: relationship.sourceDiagramTypes.slice(0, 8),
  };
}

function safeArchitectureStory(story: ArchitectureStory | undefined, analysis: AnalysisJob) {
  return {
    summary: clip(story?.plainEnglishSummary ?? "No deterministic plain-English summary is available.", 1_200),
    confidence: story?.confidence ?? "needs-verification",
    caveats: (story?.caveats ?? []).slice(0, 8).map((item) => clip(item, 400)),
    coverage: {
      status: story?.coverage.status ?? "limited",
      filesAnalyzed: story?.coverage.filesAnalyzed ?? analysis.filesAnalyzed,
      filesDiscovered: story?.coverage.filesDiscovered ?? analysis.filesDiscovered,
      evidenceBackedFindings: story?.coverage.evidenceBackedFindings ?? analysis.findings.length,
      availableDiagramTypes: (story?.coverage.availableDiagramTypes ?? []).slice(0, 12),
    },
    actors: (story?.actors ?? []).slice(0, 40).map(safeArchitectureActor),
    steps: (story?.steps ?? []).slice(0, 60).map(safeArchitectureStep),
    layers: (story?.layers ?? []).slice(0, 20).map(safeArchitectureLayer),
    relationships: (story?.relationships ?? []).slice(0, 80).map(safeArchitectureRelationship),
  };
}

function emptyPayload(analysis: AnalysisJob): ExplanationInputPayload {
  return {
    repository: {
      owner: clip(analysis.repository.owner, 160),
      name: clip(analysis.repository.name, 200),
      branch: clip(analysis.repository.selectedBranch || analysis.repository.defaultBranch, 200),
    },
    architectureStory: safeArchitectureStory(analysis.architectureStory, analysis),
    technologies: [],
    directories: [],
    entryPoints: [],
    apiRoutes: [],
    authentication: [],
    databases: [],
    externalIntegrations: [],
    moduleRelationships: [],
    diagrams: [],
    truncation: { truncated: false, omittedSections: [] },
  };
}

function basePayload(analysis: AnalysisJob, diagrams: readonly Diagram[]): ExplanationInputPayload {
  const findings = analysis.findings ?? [];
  const byKind = (kind: string): ExplanationFinding[] => findings.filter((finding) => finding.kind === kind).slice(0, 80).map(safeFinding);
  const payload = emptyPayload(analysis);
  payload.technologies = (analysis.technologies ?? []).slice(0, 80).map(safeFinding);
  payload.directories = byKind("directory");
  payload.entryPoints = byKind("entry-point");
  payload.apiRoutes = (analysis.apiRoutes ?? []).slice(0, 100).map(safeApiRoute);
  payload.authentication = (analysis.authentication ?? []).slice(0, 80).map((finding: AuthenticationFinding) => safeFinding(finding));
  payload.databases = (analysis.databases ?? []).slice(0, 80).map((finding: DatabaseFinding) => safeFinding(finding));
  payload.externalIntegrations = (analysis.externalIntegrations ?? []).slice(0, 80).map((finding: ExternalIntegrationFinding) => safeFinding(finding));
  payload.moduleRelationships = (analysis.moduleRelationships ?? []).slice(0, 120).map(safeModuleRelationship);
  payload.diagrams = diagrams.slice(0, 12).map(safeDiagram);
  return payload;
}

function serialized(payload: ExplanationInputPayload): string {
  return JSON.stringify(payload);
}

function compactPayload(payload: ExplanationInputPayload): ExplanationInputPayload {
  const compact = structuredClone(payload);
  compact.architectureStory.summary = clip(compact.architectureStory.summary, 400);
  compact.architectureStory.caveats = compact.architectureStory.caveats.slice(0, 3).map((item) => clip(item, 180));
  compact.architectureStory.actors = compact.architectureStory.actors.slice(0, 15).map((actor) => ({
    ...actor,
    technicalLabel: clip(actor.technicalLabel, 120),
    plainEnglishLabel: clip(actor.plainEnglishLabel, 120),
    explanation: clip(actor.explanation, 300),
    evidenceIds: actor.evidenceIds.slice(0, 4),
    evidence: actor.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 180), reason: clip(item.reason, 140), excerpt: item.excerpt ? clip(item.excerpt, 140) : undefined })),
  }));
  compact.architectureStory.steps = compact.architectureStory.steps.slice(0, 20).map((step) => ({
    ...step,
    technicalLabel: clip(step.technicalLabel, 120),
    plainEnglishLabel: clip(step.plainEnglishLabel, 120),
    explanation: clip(step.explanation, 300),
    technicalDetail: step.technicalDetail ? clip(step.technicalDetail, 240) : undefined,
    evidenceIds: step.evidenceIds.slice(0, 4),
    evidence: step.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 180), reason: clip(item.reason, 140), excerpt: item.excerpt ? clip(item.excerpt, 140) : undefined })),
  }));
  compact.architectureStory.layers = compact.architectureStory.layers.slice(0, 10).map((layer) => ({
    ...layer,
    technicalLabel: clip(layer.technicalLabel, 120),
    plainEnglishLabel: clip(layer.plainEnglishLabel, 120),
    purpose: clip(layer.purpose, 240),
    explanation: clip(layer.explanation, 240),
    evidenceIds: layer.evidenceIds.slice(0, 4),
    evidence: layer.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 180), reason: clip(item.reason, 140), excerpt: item.excerpt ? clip(item.excerpt, 140) : undefined })),
  }));
  compact.architectureStory.relationships = compact.architectureStory.relationships.slice(0, 24).map((relationship) => ({
    ...relationship,
    sourceLabel: clip(relationship.sourceLabel, 120),
    targetLabel: clip(relationship.targetLabel, 120),
    label: clip(relationship.label, 120),
    plainEnglishLabel: clip(relationship.plainEnglishLabel, 120),
    explanation: clip(relationship.explanation, 300),
    evidenceIds: relationship.evidenceIds.slice(0, 4),
    evidence: relationship.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 180), reason: clip(item.reason, 140), excerpt: item.excerpt ? clip(item.excerpt, 140) : undefined })),
  }));
  const compactFinding = (finding: ExplanationFinding): ExplanationFinding => ({
    ...finding,
    technicalLabel: clip(finding.technicalLabel, 120),
    plainEnglishLabel: clip(finding.plainEnglishLabel, 120),
    explanation: clip(finding.explanation, 350),
    technicalDetail: finding.technicalDetail ? clip(finding.technicalDetail, 300) : undefined,
    evidenceIds: finding.evidenceIds.slice(0, 4),
    evidence: finding.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 220), reason: clip(item.reason, 180), excerpt: item.excerpt ? clip(item.excerpt, 180) : undefined })),
  });
  compact.technologies = compact.technologies.slice(0, 20).map(compactFinding);
  compact.directories = compact.directories.slice(0, 20).map(compactFinding);
  compact.entryPoints = compact.entryPoints.slice(0, 20).map(compactFinding);
  compact.authentication = compact.authentication.slice(0, 20).map(compactFinding);
  compact.databases = compact.databases.slice(0, 20).map(compactFinding);
  compact.externalIntegrations = compact.externalIntegrations.slice(0, 20).map(compactFinding);
  compact.apiRoutes = compact.apiRoutes.slice(0, 30).map((route) => ({ ...route, route: clip(route.route, 180), filePath: clip(route.filePath, 220), explanation: clip(route.explanation, 350), evidenceIds: route.evidenceIds.slice(0, 4), evidence: route.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 220), reason: clip(item.reason, 180), excerpt: item.excerpt ? clip(item.excerpt, 180) : undefined })) }));
  compact.moduleRelationships = compact.moduleRelationships.slice(0, 30).map((relationship) => ({ ...relationship, sourceFile: clip(relationship.sourceFile, 180), targetFile: clip(relationship.targetFile, 180), specifier: clip(relationship.specifier, 120), evidenceIds: relationship.evidenceIds.slice(0, 4), evidence: relationship.evidence.slice(0, 4).map((item) => ({ ...item, filePath: clip(item.filePath, 180), reason: clip(item.reason, 140), excerpt: item.excerpt ? clip(item.excerpt, 140) : undefined })) }));
  compact.diagrams = compact.diagrams.slice(0, 4).map((diagram) => ({ ...diagram, title: clip(diagram.title, 140), description: clip(diagram.description, 240), nodes: diagram.nodes.slice(0, 25).map((node) => ({ ...node, label: clip(node.label, 120), plainEnglishLabel: clip(node.plainEnglishLabel, 120), evidenceIds: node.evidenceIds.slice(0, 4) })), edges: diagram.edges.slice(0, 40).map((edge) => ({ ...edge, label: clip(edge.label, 120), evidenceIds: edge.evidenceIds.slice(0, 4) })) }));
  return compact;
}

export function buildExplanationInput(analysis: AnalysisJob, diagrams: readonly Diagram[] = analysis.diagrams ?? [], maxChars = DEFAULT_MAX_INPUT_CHARS): ExplanationInputResult {
  const original = basePayload(analysis, diagrams);
  const originalText = serialized(original);
  if (originalText.length <= maxChars) return { payload: original, serialized: originalText, truncated: false };

  const compact = compactPayload(original);
   compact.truncation = { truncated: true, omittedSections: ["excerpts", "lower-priority findings", "additional architecture elements", "additional diagram elements"] };
  const compactText = serialized(compact);
  if (compactText.length <= maxChars) return { payload: compact, serialized: compactText, truncated: true };

  const minimal = emptyPayload(analysis);
  minimal.architectureStory.summary = clip(minimal.architectureStory.summary, 160);
   minimal.architectureStory.caveats = [];
   minimal.architectureStory.actors = compact.architectureStory.actors.slice(0, 2).map((actor) => ({ ...actor, evidence: actor.evidence.slice(0, 1), evidenceIds: actor.evidenceIds.slice(0, 1), explanation: clip(actor.explanation, 120) }));
   minimal.architectureStory.steps = compact.architectureStory.steps.slice(0, 3).map((step) => ({ ...step, evidence: step.evidence.slice(0, 1), evidenceIds: step.evidenceIds.slice(0, 1), explanation: clip(step.explanation, 120), technicalDetail: step.technicalDetail ? clip(step.technicalDetail, 120) : undefined }));
   minimal.architectureStory.layers = compact.architectureStory.layers.slice(0, 3).map((layer) => ({ ...layer, evidence: layer.evidence.slice(0, 1), evidenceIds: layer.evidenceIds.slice(0, 1), purpose: clip(layer.purpose, 120), explanation: clip(layer.explanation, 120) }));
   minimal.architectureStory.relationships = [];
  minimal.technologies = compact.technologies.slice(0, 5).map((finding) => ({ ...finding, explanation: clip(finding.explanation, 120), evidence: [], evidenceIds: finding.evidenceIds.slice(0, 2) }));
   minimal.truncation = { truncated: true, omittedSections: ["directories", "entryPoints", "apiRoutes", "authentication", "databases", "externalIntegrations", "moduleRelationships", "relationships", "diagrams"] };
  let minimalText = serialized(minimal);
  if (minimalText.length > maxChars) {
    minimal.repository.owner = "";
    minimal.repository.name = "";
    minimal.repository.branch = "";
    minimal.architectureStory.summary = "";
    minimalText = serialized(minimal);
  }
  if (minimalText.length > maxChars) minimalText = "{}";
  return { payload: minimal, serialized: minimalText, truncated: true };
}
