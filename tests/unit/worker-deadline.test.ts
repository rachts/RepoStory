import { describe, expect, it } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import type { RepositoryProvider, RepositoryReference, RepositorySnapshot } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import type { Result } from "@/shared/result";
import { AppError } from "@/domain/errors";
import type { AnalysisJobRecord } from "@/domain/analysis";

class HangingRepositoryProvider implements RepositoryProvider {
  cacheStore = undefined;
  async getSnapshot(
    _ref: RepositoryReference,
    signal?: AbortSignal,
    _budget?: AnalysisBudget,
    _onProgress?: (progress: { stage: string; progress: number; message: string }) => void,
  ): Promise<Result<RepositorySnapshot, AppError>> {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new AppError({
          code: "ANALYSIS_TIMEOUT",
          stage: "fetch",
          message: "Operation timed out",
          retryable: false,
        }));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new AppError({
          code: "ANALYSIS_TIMEOUT",
          stage: "fetch",
          message: "Operation timed out",
          retryable: false,
        }));
      }, { once: true });
    });
  }
}

function createPendingJob(id = "job-deadline-test"): AnalysisJobRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    jobId: id,
    analysisId: null,
    repositoryUrl: "https://github.com/fixture/hanging-repo",
    branch: "default",
    ownerId: "session-deadline",
    cacheKey: "cache-deadline",
    status: "queued",
    stage: "validating-input",
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    retryCount: 0,
    explanationRequested: false,
  };
}

describe("worker analysis deadline enforcement", () => {
  it("fails with ANALYSIS_TIMEOUT at the deadline without user cancellation", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    await store.createJob(createPendingJob());

    const runner = new AnalysisJobRunner(store, new HangingRepositoryProvider(), {
      maxConcurrentJobs: 1,
      maxRetries: 0,
      analysisTimeoutMs: 50,
    });

    await runner.runNow("job-deadline-test");

    const job = await store.getJob("job-deadline-test", "session-deadline");
    expect(job).toBeDefined();
    expect(job?.status).toBe("failed");
    expect(job?.error?.code).toBe("ANALYSIS_TIMEOUT");
    expect(job?.cancellationRequested).toBeFalsy();
  });
});
