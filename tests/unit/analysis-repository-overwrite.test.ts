import { describe, expect, it } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import type { RepositoryProvider, RepositorySnapshot } from "@/domain/repository";
import type { AnalysisResult } from "@/domain/analysis";
import type { Result } from "@/shared/result";
import { ok } from "@/shared/result";
import { AppError } from "@/domain/errors";

class ControlledProvider implements RepositoryProvider {
  cacheStore = undefined;
  public delayMs = 0;
  public onSnapshotStart?: () => void | Promise<void>;

  async getSnapshot(): Promise<Result<RepositorySnapshot, AppError>> {
    if (this.onSnapshotStart) {
      await this.onSnapshotStart();
    }
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const repo = {
      id: "repo-1",
      owner: "test-org",
      name: "test-repo",
      url: "https://github.com/test-org/test-repo",
      defaultBranch: "main",
      selectedBranch: "main",
      sizeBytes: 100,
      fileCount: 1,
      commitSha: "sha-controlled",
    };
    return ok({
      repository: repo,
      files: [{ path: "index.ts", content: "console.log('hi');", type: "file" as const, isAnalyzable: true }],
    });
  }
}

function createJobRecord(jobId: string, ownerId: string, status: "queued" | "fetching" | "failed" = "queued") {
  const now = new Date().toISOString();
  return {
    jobId,
    analysisId: `analysis-${jobId}`,
    repositoryUrl: "https://github.com/test-org/test-repo",
    branch: "main",
    ownerId,
    cacheKey: `cache-${jobId}`,
    status,
    stage: "validating-input" as const,
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
  };
}

describe("anti-revival and overwrite protection", () => {
  it("saveAnalysisResult returns false and does not persist when job is failed", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const jobId = "job-failed-save-test";
    const ownerId = "owner-failed-test";

    await store.createJob(createJobRecord(jobId, ownerId, "failed"));

    const mockResult: AnalysisResult = {
      id: `analysis-${jobId}`,
      repository: {
        id: "repo-1",
        owner: "test-org",
        name: "test-repo",
        url: "https://github.com/test-org/test-repo",
        defaultBranch: "main",
        selectedBranch: "main",
        sizeBytes: 100,
        fileCount: 1,
        commitSha: "sha-1",
      },
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      filesDiscovered: 1,
      filesAnalyzed: 1,
      technologies: [],
      findings: [],
      diagramIds: [],
      createdAt: new Date().toISOString(),
    };

    const saved = await store.saveAnalysisResult(mockResult, ownerId);
    expect(saved).toBe(false);

    const retrieved = await store.getAnalysisResult(`analysis-${jobId}`, ownerId);
    expect(retrieved).toBeUndefined();
  });

  it("runner skips execution immediately if job status is already failed (e.g. requeued stale job)", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const jobId = "job-requeued-failed";
    const ownerId = "owner-requeued";

    await store.createJob(createJobRecord(jobId, ownerId, "failed"));

    let providerCalled = false;
    const provider = new ControlledProvider();
    provider.onSnapshotStart = () => {
      providerCalled = true;
    };

    const runner = new AnalysisJobRunner(store, provider, {
      maxConcurrentJobs: 1,
      maxRetries: 0,
    });

    await runner.runNow(jobId);

    expect(providerCalled).toBe(false);
    const job = await store.getJob(jobId, ownerId);
    expect(job?.status).toBe("failed");
  });

  it("prevents late-finishing worker from reviving a job that the sweeper marked failed", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const jobId = "job-sweeper-race";
    const ownerId = "owner-race";

    await store.createJob(createJobRecord(jobId, ownerId, "queued"));

    const provider = new ControlledProvider();
    provider.onSnapshotStart = async () => {
      // Simulate sweeper marking the job as failed mid-analysis
      await store.updateJob(jobId, {
        status: "failed",
        stage: "completed",
        progress: 100,
        message: "Analysis worker stopped responding",
        error: {
          code: "JOB_STALLED",
          stage: "analyze",
          reason: "Sweeper marked job failed",
          message: "Analysis worker stopped responding",
          hint: "Retry",
          retryable: true,
        },
        updatedAt: new Date().toISOString(),
      });
    };

    const runner = new AnalysisJobRunner(store, provider, {
      maxConcurrentJobs: 1,
      maxRetries: 0,
    });

    await runner.runNow(jobId);

    // Verify job was NOT revived to completed
    const finalJob = await store.getJob(jobId, ownerId);
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.error?.code).toBe("JOB_STALLED");
    expect(finalJob?.message).toBe("Analysis worker stopped responding");
  });
});
