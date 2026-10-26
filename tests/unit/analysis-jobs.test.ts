import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import type { AnalysisJobRecord } from "@/domain/analysis";

function job(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    jobId: "job-fixture",
    analysisId: null,
    repositoryUrl: "https://github.com/fixture/small-react",
    branch: "default",
    ownerId: "session-fixture",
    cacheKey: "cache-fixture",
    status: "queued",
    stage: "validating-input",
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    retryCount: 0,
    explanationRequested: false,
    ...overrides,
  };
}

describe("durable analysis jobs", () => {
  let store: InMemoryAnalysisStore;

  beforeEach(() => {
    store = new InMemoryAnalysisStore({ maxAnalyses: 10, ttlMs: 60_000 });
  });

  it("deduplicates active requests for the same owner and cache key", async () => {
    const first = await store.createOrReuseJob(job());
    const second = await store.createOrReuseJob(job({ jobId: "job-other" }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
  });

  it("does not allow cancellation to be overwritten by result persistence", async () => {
    await store.createJob(job({ analysisId: "analysis-fixture", status: "analyzing", stage: "analyzing-repository", cancellationRequested: true }));
    const saved = await store.saveAnalysisResult({
      id: "analysis-fixture",
      repository: { id: "repo", owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react", defaultBranch: "main", selectedBranch: "main", sizeBytes: 1, fileCount: 1 },
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      filesDiscovered: 1,
      filesAnalyzed: 1,
      technologies: [],
      findings: [],
      diagramIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }, "session-fixture");

    expect(saved).toBe(false);
    expect(await store.getAnalysisResult("analysis-fixture", "session-fixture")).toBeUndefined();
  });

  it("runs a fixture job and persists the deterministic result before completion", async () => {
    await store.createJob(job());
    const runner = new AnalysisJobRunner(store, new FixtureRepositoryProvider(), { maxConcurrentJobs: 1, maxRetries: 0 });
    await runner.runNow("job-fixture");

    const completed = await store.getJob("job-fixture", "session-fixture");
    expect(completed?.status).toBe("completed");
    expect(completed?.analysisId).toBeTruthy();
    expect(await store.getAnalysisResult(completed!.analysisId!, "session-fixture")).toBeDefined();
  });
});
