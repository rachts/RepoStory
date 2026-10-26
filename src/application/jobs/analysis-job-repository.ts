import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { AnalysisJobError, AnalysisJobRecord, AnalysisResult } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";

export interface AnalysisJobPatch {
  analysisId?: string | null;
  branch?: string;
  status?: AnalysisJobRecord["status"];
  stage?: AnalysisJobRecord["stage"];
  progress?: number;
  message?: string;
  updatedAt?: string;
  expiresAt?: string;
  retryCount?: number;
  cancellationRequested?: boolean;
  error?: AnalysisJobError;
  coverage?: AnalysisJobRecord["coverage"];
}

/** Replaceable persistence boundary for asynchronous analysis jobs and results. */
export interface AnalysisJobRepository {
  createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord>;
  createOrReuseJob(job: AnalysisJobRecord): Promise<{ job: AnalysisJobRecord; created: boolean }>;
  getJob(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined>;
  updateJob(jobId: string, patch: AnalysisJobPatch, ownerId?: string): Promise<AnalysisJobRecord | undefined>;
  findReusableJob(cacheKey: string, ownerId: string, now?: number): Promise<AnalysisJobRecord | undefined>;
  getJobByAnalysisId(analysisId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined>;
  markExpiredJobs(now?: number): Promise<number>;
  deleteExpiredJobs(now?: number): Promise<number>;

  saveAnalysisResult(result: AnalysisResult, ownerId?: string): Promise<boolean>;
  getAnalysisResult(analysisId: string, ownerId?: string): Promise<AnalysisResult | undefined>;

  saveExplanation(analysisId: string, explanation: ProjectExplanation, ownerId?: string): Promise<void>;
  getExplanation(analysisId: string, ownerId?: string): Promise<ProjectExplanation | undefined>;
  saveExplanationUnavailable(analysisId: string, unavailable: { code: string; message: string }, ownerId?: string): Promise<void>;
  getExplanationUnavailable(analysisId: string, ownerId?: string): Promise<{ code: string; message: string } | undefined>;

  saveAnalysisDiagram(diagram: Diagram, ownerId?: string): Promise<void>;
  getAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined>;
  listAnalysisDiagrams(analysisId: string, ownerId?: string): Promise<Diagram[]>;
  resetAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined>;
}

export interface PersistedAnalysisRepositoryState {
  version: 1;
  jobs: AnalysisJobRecord[];
  results: AnalysisResult[];
  explanations: Array<{ analysisId: string; explanation: ProjectExplanation }>;
  explanationUnavailable: Array<{ analysisId: string; unavailable: { code: string; message: string } }>;
  diagrams: Diagram[];
  generatedDiagrams: Diagram[];
}
