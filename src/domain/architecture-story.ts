import type { DiagramType } from "@/domain/diagram";
import type { EvidenceReference } from "@/domain/evidence";
import type { ConfidenceLevel } from "@/domain/finding";

export type ArchitectureActorKind =
  | "person"
  | "browser"
  | "frontend"
  | "backend"
  | "database"
  | "external-service";

export type ArchitectureStepKind =
  | "application"
  | "api"
  | "authentication"
  | "database"
  | "directory"
  | "external-service"
  | "module"
  | "technology";

export type ArchitectureLayerKind =
  | "client"
  | "application"
  | "request"
  | "identity"
  | "module"
  | "data"
  | "external-service"
  | "repository";

export type ArchitectureRelationshipKind =
  | "contains"
  | "uses"
  | "built-with"
  | "dispatches"
  | "imports"
  | "calls"
  | "authenticates"
  | "evaluates"
  | "connects";

export type ArchitectureRelationshipVerification = "supported" | "inferred" | "needs-verification";

export type ArchitectureStoryCoverageStatus = "complete" | "partial" | "limited" | "empty";

export interface ArchitectureStoryDiagramAvailability {
  type: DiagramType;
  available: boolean;
  confidence?: ConfidenceLevel;
  reason?: string;
}

export interface ArchitectureActor {
  id: string;
  kind: ArchitectureActorKind;
  /** Short technical-facing name retained for evidence panels and exports. */
  label: string;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  inferred: boolean;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceNodeIds: string[];
  sourceDiagramTypes: DiagramType[];
}

export interface ArchitectureStep {
  id: string;
  kind: ArchitectureStepKind;
  order: number;
  layerId: string;
  /** Plain-English step title used by the story view. */
  title: string;
  plainEnglishTitle: string;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceNodeIds: string[];
  targetNodeIds: string[];
  sourceDiagramTypes: DiagramType[];
}

export interface ArchitectureRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  /** Aliases make the relationship easy to consume in a story renderer. */
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  kind: ArchitectureRelationshipKind;
  relationship: ArchitectureRelationshipKind;
  label: string;
  plainEnglishLabel: string;
  explanation: string;
  inferred: boolean;
  verification: ArchitectureRelationshipVerification;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceEdgeIds: string[];
  sourceDiagramTypes: DiagramType[];
}

export interface ArchitectureLayer {
  id: string;
  kind: ArchitectureLayerKind;
  order: number;
  /** Short technical-facing layer name retained for technical mode. */
  label: string;
  technicalLabel: string;
  plainEnglishLabel: string;
  purpose: string;
  explanation: string;
  nodeIds: string[];
  actorIds: string[];
  stepIds: string[];
  relationshipIds: string[];
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  sourceDiagramTypes: DiagramType[];
}

export interface ArchitectureStoryCoverage {
  status: ArchitectureStoryCoverageStatus;
  partial: boolean;
  filesAnalyzed: number;
  filesDiscovered: number;
  analyzedFiles: number;
  discoveredFiles: number;
  /** Number of discovered files excluded before analysis. */
  filesSkipped?: number;
  /** Byte totals are optional for older stored analyses and fixture responses. */
  bytesAnalyzed?: number;
  bytesDiscovered?: number;
  bytesSkipped?: number;
  evidenceBackedFindings: number;
  evidenceBackedElements: number;
  availableDiagramTypes: DiagramType[];
  unavailableDiagramTypes: ArchitectureStoryDiagramAvailability[];
  diagramAvailability: ArchitectureStoryDiagramAvailability[];
  repositoryStructureAvailable: boolean;
  systemOverviewAvailable: boolean;
  apiRequestFlowAvailable: boolean;
  authenticationFlowAvailable: boolean;
  caveats: string[];
}

export interface ArchitectureStory {
  id: string;
  headline: string;
  summary: string;
  /** Explicit plain-English summary used at the top of the results view. */
  plainEnglishSummary: string;
  technicalSummary?: string;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  actors: ArchitectureActor[];
  steps: ArchitectureStep[];
  layers: ArchitectureLayer[];
  relationships: ArchitectureRelationship[];
  coverage: ArchitectureStoryCoverage;
  caveats: string[];
}
