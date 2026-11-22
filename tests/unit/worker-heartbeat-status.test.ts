import { describe, expect, it } from "vitest";
import type { AnalysisJobRecord } from "@/domain/analysis";
import { GET as jobGet } from "@/app/api/analyze/jobs/[jobId]/route";
import { analysisRepository } from "@/composition/container";

function createJob(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  return {
    jobId: "test-heartbeat-job",
    analysisId: null,
    repositoryUrl: "https://github.com/org/repo",
    branch: "main",
    ownerId: "session-heartbeat-test",
    cacheKey: "cache-heartbeat-1",
    status: "analyzing",
    stage: "analyzing-repository",
    progress: 50,
    message: "Analyzing AST",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
    ...overrides,
  };
}

describe("worker heartbeat and workerStatus in job status API", () => {
  it("returns workerStatus: 'active' and heartbeatAt when worker heartbeat is recent", async () => {
    const recentHeartbeat = new Date(Date.now() - 5 * 1000).toISOString(); // 5s ago
    await analysisRepository.createJob(createJob({
      jobId: "job-heartbeat-active",
      heartbeatAt: recentHeartbeat,
    }));

    const response = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": "session-heartbeat-test" } }),
      { params: Promise.resolve({ jobId: "job-heartbeat-active" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { heartbeatAt?: string | null; workerStatus?: string };
    expect(body.heartbeatAt).toBe(recentHeartbeat);
    expect(body.workerStatus).toBe("active");
  });

  it("returns workerStatus: 'offline' when worker heartbeat is older than 40s on active job", async () => {
    const staleHeartbeat = new Date(Date.now() - 50 * 1000).toISOString(); // 50s ago (stale, but < 2m stalled limit)
    await analysisRepository.createJob(createJob({
      jobId: "job-heartbeat-stale",
      heartbeatAt: staleHeartbeat,
    }));

    const response = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": "session-heartbeat-test" } }),
      { params: Promise.resolve({ jobId: "job-heartbeat-stale" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { heartbeatAt?: string | null; workerStatus?: string; status: string };
    expect(body.status).toBe("analyzing");
    expect(body.heartbeatAt).toBe(staleHeartbeat);
    expect(body.workerStatus).toBe("offline");
  });

  it("returns workerStatus: 'idle' when job is completed or failed", async () => {
    await analysisRepository.createJob(createJob({
      jobId: "job-heartbeat-completed",
      status: "completed",
      stage: "completed",
      progress: 100,
    }));

    const response = await jobGet(
      new Request("http://localhost/api/analyze/jobs", { headers: { "x-repo-story-session": "session-heartbeat-test" } }),
      { params: Promise.resolve({ jobId: "job-heartbeat-completed" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { workerStatus?: string; status: string };
    expect(body.status).toBe("completed");
    expect(body.workerStatus).toBe("idle");
  });
});
