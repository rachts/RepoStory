import type { AnalysisFinding, ConfidenceLevel } from "@/domain/finding";
import type { Repository, RepositoryFile } from "@/domain/repository";

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
  diagramIds: string[];
  error?: AnalysisError;
  createdAt: string;
  completedAt?: string;
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
