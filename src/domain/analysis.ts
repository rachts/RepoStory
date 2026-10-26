import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, DatabaseFinding, ExternalIntegrationFinding, ConfidenceLevel, ModuleRelationship } from "@/domain/finding";
import type { DiagramType } from "@/domain/diagram";
import type { Repository, RepositoryFile } from "@/domain/repository";
import type { ArchitectureStory } from "@/domain/architecture-story";
import type { ProjectExplanation } from "@/domain/ai-explanation";

export type AnalysisResultStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisResultStage =
  | "validating"
  | "fetching-metadata"
  | "fetching-files"
  | "filtering-files"
  | "analyzing"
  | "generating-diagrams"
  | "completed";

export type AnalysisJobStatus =
  | "queued"
  | "fetching"
  | "analyzing"
  | "explaining"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export type AnalysisJobStage =
  | "validating-input"
  | "fetching-metadata"
  | "fetching-tree"
  | "fetching-content"
  | "analyzing-repository"
  | "generating-explanation"
  | "storing-result"
  | "completed";

export type AnalysisConfidence = "high" | "medium" | "low";

export interface AnalysisCoverage {
  filesConsidered: number;
  filesSkipped: number;
  filesSkippedByReason: {
    tooLarge: number;
    unsupported: number;
    limitReached: number;
  };
  treeTruncated: boolean;
  analysisConfidence: AnalysisConfidence;
}

export interface AnalysisJobProgress {
  progress: number;
  stage: AnalysisJobStage;
  message: string;
}

export interface AnalysisJobError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean>;
}

export interface AnalysisJobRecord {
  jobId: string;
  analysisId: string | null;
  repositoryUrl: string;
  branch: string;
  requestedBranch?: string;
  ownerId: string;
  cacheKey: string;
  status: AnalysisJobStatus;
  stage: AnalysisJobStage;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  retryCount: number;
  explanationRequested: boolean;
  cancellationRequested?: boolean;
  error?: AnalysisJobError;
  coverage?: AnalysisCoverage;
}

/**
 * The deterministic analysis payload. This is kept separate from the durable
 * job record so status polling never has to carry the full result.
 */
export interface AnalysisResult {
  id: string;
  repository: Repository;
  status: AnalysisResultStatus;
  stage: AnalysisResultStage;
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
  coverage?: AnalysisCoverage;
  explanation?: ProjectExplanation;
  explanationUnavailable?: { code: string; message: string };
}

/** Backward-compatible result name used by the existing UI and test fixtures. */
export type AnalysisJob = AnalysisResult;

/** Backward-compatible names for older pipeline consumers. */
export type LegacyAnalysisStatus = AnalysisResultStatus;
export type LegacyAnalysisStage = AnalysisResultStage;

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
    | "GITHUB_AUTH_FAILED"
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
    | "ANALYSIS_STORAGE_UNAVAILABLE"
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
