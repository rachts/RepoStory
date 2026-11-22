import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, DatabaseFinding, ExternalIntegrationFinding, ConfidenceLevel, ModuleRelationship } from "@/domain/finding";
import type { DiagramType } from "@/domain/diagram";
import type { Repository } from "@/domain/repository";
import type { ArchitectureStory } from "@/domain/architecture-story";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { AnalysisErrorStage } from "@/domain/errors";

export type AnalysisResultStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisResultStage =
  | "validating"
  | "fetching-metadata"
  | "fetch-metadata"
  | "fetching-tree"
  | "fetch-tree"
  | "fetching-files"
  | "fetching-content"
  | "fetch-archive"
  | "filtering-files"
  | "analyzing"
  | "analyze"
  | "generating-diagrams"
  | "generate-diagrams"
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
  | "fetch-metadata"
  | "fetching-tree"
  | "fetch-tree"
  | "fetching-content"
  | "fetch-archive"
  | "analyzing-repository"
  | "analyze"
  | "generating-diagrams"
  | "generate-diagrams"
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
    lfsPointer?: number;
    submodule?: number;
    unsupportedEncoding?: number;
    pathCollision?: number;
    parseFailure?: number;
  };
  filesSkippedDetails?: Array<{
    path: string;
    reason: "lfs-pointer" | "submodule" | "unsupported-encoding" | "path-collision" | "too-large" | "unsupported" | "limit-reached" | "parse-failure";
    details?: string;
  }>;
  skippedFiles?: Array<{ path: string; reason: string }>;
  unresolvedSubtrees?: string[];
  warnings?: string[];
  analyzedPercent?: number;
  treeTruncated: boolean;
  analysisConfidence: AnalysisConfidence;
  usedFallbackContentFetch?: boolean;
  contentFetchStrategy?: "archive" | "per-file";
}

export interface AnalysisJobProgress {
  progress: number;
  stage: AnalysisJobStage;
  message: string;
}

export interface AnalysisJobError {
  code: string;
  stage?: AnalysisErrorStage;
  reason?: string;
  message: string;
  retryable: boolean;
  hint?: string;
  details?: Record<string, unknown>;
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
  heartbeatAt?: string;
  workerStatus?: "active" | "offline" | "idle";
  cancellationRequested?: boolean;
  error?: AnalysisJobError;
  coverage?: AnalysisCoverage;
  orgId?: string;
  commitSha?: string;
  blobShas?: Record<string, string>;
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
  orgId?: string;
  commitSha?: string;
  blobShas?: Record<string, string>;
  explanation?: ProjectExplanation;
  explanationUnavailable?: { code: string; message: string };
}

/** Backward-compatible result name used by the existing UI and test fixtures. */
export type AnalysisJob = AnalysisResult;

export interface DiagramAvailability {
  type: DiagramType;
  available: boolean;
  confidence?: ConfidenceLevel;
  reason?: string;
}

export interface AnalysisError {
  code:
    | "INVALID_URL"
    | "UNSUPPORTED_HOST"
    | "REPOSITORY_NOT_FOUND"
    | "REPOSITORY_NOT_FOUND_OR_PRIVATE"
    | "REPOSITORY_INACCESSIBLE"
    | "GITHUB_AUTH_FAILED"
    | "REPOSITORY_TOO_LARGE"
    | "REPO_TOO_LARGE"
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
    | "ARCHIVE_DOWNLOAD_STALLED"
    | "JOB_STALLED"
    | "JOB_EXPIRED"
    | "ANALYSIS_STORAGE_UNAVAILABLE"
    | "ANALYSIS_FAILED"
    | "CANCELLED";
  stage?: AnalysisErrorStage;
  reason?: string;
  hint?: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type {
  ArchitectureActor,
  ArchitectureLayer,
  ArchitectureStep,
  ArchitectureStory,
} from "@/domain/architecture-story";
