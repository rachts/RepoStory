import { describe, expect, it } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import type { AnalysisJobRecord } from "@/domain/analysis";
import { GET as jobGet } from "@/app/api/analyze/jobs/[jobId]/route";
import { analysisRepository } from "@/composition/container";

function createJob(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  return {
    jobId: "stuck-job-1",
    analysisId: "analysis-stuck-1",
    repositoryUrl: "https://github.com/org/repo",
    branch: "main",
    ownerId: "owner-1",
    cacheKey: "cache-1",
    status: "fetching",
    stage: "fetch-archive",
    progress: 45,
    message: "Fetching archive",
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
    ...overrides,
  };
}

describe("stuck job recovery and retryable expiration", () => {
  it("transitions a job frozen in fetching with a stale heartbeat to failed with retryable: true", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    await store.createJob(createJob({ heartbeatAt: staleHeartbeat }));

    const recovered = await (store as unknown as { recoverStuckJobs: (now?: number, timeoutMs?: number) => Promise<AnalysisJobRecord[]> }).recoverStuckJobs();

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe("stuck-job-1");
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.error?.code).toBe("JOB_STALLED");
    expect(recovered[0]?.error?.retryable).toBe(true);

    const updatedJob = await store.getJob("stuck-job-1", "owner-1");
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.error?.code).toBe("JOB_STALLED");
    expect(updatedJob?.error?.retryable).toBe(true);
  });

  it("marks expired jobs with retryable: true so users can retry", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const expiredTime = new Date(Date.now() - 1000).toISOString();
    await store.createJob(createJob({ jobId: "expired-job", expiresAt: expiredTime }));

    await store.markExpiredJobs();

    const job = await store.getJob("expired-job", "owner-1");
    expect(job?.status).toBe("expired");
    expect(job?.error?.code).toBe("JOB_EXPIRED");
    expect(job?.error?.retryable).toBe(true);
  });

  it("marks a stuck fetching job as failed with JOB_STALLED via GET /api/analyze/jobs/[jobId]", async () => {
    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    await analysisRepository.createJob(createJob({
      jobId: "job-endpoint-stalled",
      ownerId: "session-stalled-test",
      status: "fetching",
      stage: "fetch-archive",
      heartbeatAt: staleHeartbeat,
    }));

    const response = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": "session-stalled-test" } }),
      { params: Promise.resolve({ jobId: "job-endpoint-stalled" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; stage: string; error?: { code: string; message: string; retryable: boolean } };
    expect(body.status).toBe("failed");
    expect(body.stage).toBe("completed");
    expect(body.error?.code).toBe("JOB_STALLED");
    expect(body.error?.message).toBe("Analysis worker stopped responding");
    expect(body.error?.retryable).toBe(true);
  });

  it("does not mark a job failed if heartbeatAt is null but updatedAt is fresh (legacy pre-migration 005 jobs)", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const freshUpdated = new Date(Date.now() - 30 * 1000).toISOString(); // 30 seconds ago
    await store.createJob(createJob({
      jobId: "legacy-fresh-job",
      status: "fetching",
      heartbeatAt: undefined,
      updatedAt: freshUpdated,
    }));

    const recovered = await (store as unknown as { recoverStuckJobs: (now?: number, timeoutMs?: number) => Promise<AnalysisJobRecord[]> }).recoverStuckJobs();
    expect(recovered.length).toBe(0);

    const job = await store.getJob("legacy-fresh-job", "owner-1");
    expect(job?.status).toBe("fetching");
  });

  it("marks a legacy pre-migration 005 job failed if heartbeatAt is null AND updatedAt is stale", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const staleUpdated = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    await store.createJob(createJob({
      jobId: "legacy-stale-job",
      status: "fetching",
      heartbeatAt: undefined,
      updatedAt: staleUpdated,
    }));

    const recovered = await (store as unknown as { recoverStuckJobs: (now?: number, timeoutMs?: number) => Promise<AnalysisJobRecord[]> }).recoverStuckJobs();
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe("legacy-stale-job");
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.error?.code).toBe("JOB_STALLED");
  });
});
