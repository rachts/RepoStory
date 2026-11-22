import { describe, expect, it } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import { InMemoryJobQueue } from "@/infrastructure/jobs/in-memory-job-queue";
import { activeJobIds, failActiveJobsOnCrash, resetCrashStateForTesting } from "@/application/jobs/worker-crash-handler";
import type { AnalysisJobRecord } from "@/domain/analysis";

function createJob(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  const now = new Date().toISOString();
  return {
    jobId: "crash-job-1",
    analysisId: null,
    repositoryUrl: "https://github.com/org/crash-repo",
    branch: "main",
    ownerId: "owner-crash",
    cacheKey: "cache-crash",
    status: "fetching",
    stage: "fetch-archive",
    progress: 45,
    message: "Fetching archive",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
    ...overrides,
  };
}

describe("worker crash handling", () => {
  it("awaits mark-failed write and marks active job as failed with JOB_STALLED after a crash", async () => {
    resetCrashStateForTesting();
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const queue = new InMemoryJobQueue();
    await store.createJob(createJob());
    await queue.enqueue("crash-job-1");
    await queue.claim("test-worker-1");

    activeJobIds.add("crash-job-1");

    let exitCode: number | null = null;
    const fakeExit = (code: number) => {
      exitCode = code;
    };

    await failActiveJobsOnCrash(
      "uncaughtException",
      new Error("Simulated Out Of Memory crash"),
      store,
      queue,
      "test-worker-1",
      fakeExit,
    );

    expect(exitCode).toBe(1);

    const job = await store.getJob("crash-job-1", "owner-crash");
    expect(job).toBeDefined();
    expect(job?.status).toBe("failed");
    expect(job?.error?.code).toBe("JOB_STALLED");
    expect(job?.error?.message).toBe("Analysis worker stopped responding");
    expect(job?.error?.retryable).toBe(true);
  });
});
