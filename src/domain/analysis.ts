import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, DatabaseFinding, ExternalIntegrationFinding, ConfidenceLevel, ModuleRelationship } from "@/domain/finding";
import type { DiagramType } from "@/domain/diagram";
import type { Repository, RepositoryFile } from "@/domain/repository";
import type { ArchitectureStory } from "@/domain/architecture-story";

export type AnalysisStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisStage =
  | "validating"
  | "fetching-metadata"
  | "fetching-files"
  | "filtering-files"
  | "analyzing"
  | "generating-diagrams"
  | "completed";

export interface AnalysisJob {
  id: string;
  repository: Repository;
  status: AnalysisStatus;
  stage: AnalysisStage;
  progressPercent: number;
  filesDiscovered: number;
  filesAnalyzed: number;
  technologies: AnalysisFinding[];
  findings: AnalysisFinding[];
  apiRoutes?: ApiRouteFinding[];
  moduleRelationships?: ModuleRelationship[];
  databases?: DatabaseFinding[];
  externalIntegrations?: ExternalIntegrationFinding[];
  authentication?: AuthenticationFinding[];
  diagramAvailability?: DiagramAvailability[];
  diagramIds: string[];
  architectureStory?: ArchitectureStory;
  error?: AnalysisError;
  createdAt: string;
  completedAt?: string;
  diagrams?: import("@/domain/diagram").Diagram[];
}

export interface DiagramAvailability {
  type: DiagramType;
  available: boolean;
  confidence?: ConfidenceLevel;
  reason?: string;
}

export interface AnalysisInput {
  repository: Repository;
  files: RepositoryFile[];
}

export interface AnalysisError {
  code:
    | "INVALID_URL"
    | "UNSUPPORTED_HOST"
    | "REPOSITORY_NOT_FOUND"
    | "REPOSITORY_INACCESSIBLE"
    | "REPOSITORY_TOO_LARGE"
    | "FILE_LIMIT_EXCEEDED"
    | "GITHUB_RATE_LIMITED"
    | "GITHUB_TREE_TRUNCATED"
    | "GITHUB_RESPONSE_TOO_LARGE"
    | "GITHUB_INVALID_RESPONSE"
    | "GITHUB_INVALID_CONTENT"
    | "GITHUB_CONTENT_TOO_LARGE"
    | "GITHUB_INVALID_PATH"
    | "GITHUB_PATH_TOO_LONG"
    | "GITHUB_RESPONSE_READ_FAILED"
    | "INVALID_BRANCH"
    | "ANALYSIS_TIMEOUT"
    | "ANALYSIS_FAILED"
    | "CANCELLED";
  message: string;
  details?: Record<string, string | number | boolean>;
  retryable: boolean;
}

export interface PlainEnglishExplanation {
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  confidence: ConfidenceLevel;
}

export type {
  ArchitectureActor,
  ArchitectureLayer,
  ArchitectureStep,
  ArchitectureStory,
} from "@/domain/architecture-story";
