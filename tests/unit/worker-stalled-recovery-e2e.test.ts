import { describe, expect, it } from "vitest";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import type { AnalysisJobRecord } from "@/domain/analysis";
import { GET as jobGet } from "@/app/api/analyze/jobs/[jobId]/route";
import { POST as jobRetry } from "@/app/api/analyze/jobs/[jobId]/retry/route";
import { analysisRepository } from "@/composition/container";

function createPendingJob(id: string, ownerId: string): AnalysisJobRecord {
  const now = new Date().toISOString();
  return {
    jobId: id,
    analysisId: null,
    repositoryUrl: "https://github.com/fixture/small-react",
    branch: "default",
    ownerId,
    cacheKey: `cache-${id}`,
    status: "queued",
    stage: "validating-input",
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
  };
}

describe("worker stalled recovery and retry lifecycle", () => {
  it("worker starts → hangs mid-fetch → heartbeat stops → GET marks it failed/retryable → retry succeeds", async () => {
    const ownerId = "session-stalled-lifecycle";
    const jobId = "job-stalled-lifecycle-1";

    // 1. Worker starts and updates status to fetching mid-fetch
    await analysisRepository.createJob(createPendingJob(jobId, ownerId));
    await analysisRepository.updateJob(jobId, {
      status: "fetching",
      stage: "fetch-archive",
      progress: 45,
      message: "Downloading archive content",
      heartbeatAt: new Date().toISOString(),
    });

    let job = await analysisRepository.getJob(jobId, ownerId);
    expect(job?.status).toBe("fetching");

    // 2. Worker hangs mid-fetch: heartbeat stops (> 2 minutes ago)
    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await analysisRepository.updateJob(jobId, {
      heartbeatAt: staleHeartbeat,
      updatedAt: staleHeartbeat,
    });

    // 3. User polls GET endpoint -> sweeper detects stalled job and idempotently marks it failed with retryable: true
    const getResponse = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": ownerId } }),
      { params: Promise.resolve({ jobId }) },
    );

    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as { status: string; error?: { code: string; retryable: boolean } };
    expect(getBody.status).toBe("failed");
    expect(getBody.error?.code).toBe("JOB_STALLED");
    expect(getBody.error?.retryable).toBe(true);

    job = await analysisRepository.getJob(jobId, ownerId);
    expect(job?.status).toBe("failed");
    expect(job?.error?.code).toBe("JOB_STALLED");
    expect(job?.error?.retryable).toBe(true);

    // 4. Retry is triggered via POST /api/analyze/jobs/[jobId]/retry
    const retryResponse = await jobRetry(
      new Request("http://localhost/api/analyze/jobs/retry", {
        method: "POST",
        headers: { "x-repo-story-session": ownerId },
      }),
      { params: Promise.resolve({ jobId }) },
    );

    expect(retryResponse.status).toBe(200);
    const retryBody = await retryResponse.json() as { job?: AnalysisJobRecord };
    expect(retryBody.job?.status).toBe("queued");
    expect(retryBody.job?.retryCount).toBe(1);

    // 5. Worker processes the retried job to completion
    const runner = new AnalysisJobRunner(analysisRepository, new FixtureRepositoryProvider(), {
      maxConcurrentJobs: 1,
      maxRetries: 0,
    });
    await runner.runNow(jobId);

    // 6. Verify job completed successfully
    const finalJob = await analysisRepository.getJob(jobId, ownerId);
    expect(finalJob?.status).toBe("completed");
    expect(finalJob?.progress).toBe(100);
    expect(finalJob?.analysisId).toBeTruthy();

    // Verify GET endpoint returns completed result
    const finalGetResponse = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": ownerId } }),
      { params: Promise.resolve({ jobId }) },
    );
    expect(finalGetResponse.status).toBe(200);
    const finalBody = await finalGetResponse.json() as { status: string; progress: number; analysisId: string };
    expect(finalBody.status).toBe("completed");
    expect(finalBody.progress).toBe(100);
    expect(finalBody.analysisId).toBe(finalJob!.analysisId);
  });
});
