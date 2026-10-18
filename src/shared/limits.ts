export const DEFAULT_LIMITS = {
  maxFiles: 2_000,
  maxFileBytes: 500_000,
  maxTotalBytes: 50_000_000,
  maxContentBytes: 500_000,
  maxResponseBytes: 5_000_000,
  maxPathLength: 4_096,
  maxEvidenceExcerpt: 1_000,
  maxTreeEntries: 10_000,
  maxImportCandidates: 256,
  maxConcurrentContentRequests: 6,
  maxAnalysisMs: 30_000,
} as const;
export const DEFAULT_STORE_LIMITS = {
  maxAnalyses: 100,
  ttlMs: 60 * 60 * 1000,
} as const;
export type AnalysisLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxContentBytes: number;
  maxResponseBytes?: number;
  maxPathLength?: number;
  maxEvidenceExcerpt: number;
  maxTreeEntries?: number;
  maxImportCandidates?: number;
  maxConcurrentContentRequests?: number;
  maxAnalysisMs: number;
};

export interface AnalysisBudget {
  check(): void;
}

export function createAnalysisBudget(maxMs: number, now: () => number = Date.now, signal?: AbortSignal): AnalysisBudget {
  const deadline = now() + maxMs;
  return {
    check(): void {
      if (signal?.aborted || now() >= deadline) throw new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true });
    },
  };
}
import { AppError } from "@/domain/errors";
