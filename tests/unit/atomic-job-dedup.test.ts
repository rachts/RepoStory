import { describe, expect, it, vi } from "vitest";
import { InMemoryAnalysisStore } from "@/application/store";
import { SupabaseAnalysisJobRepository } from "@/infrastructure/jobs/supabase-analysis-job-repository";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import type { AnalysisJobRecord } from "@/domain/analysis";
import type { RepositoryProvider } from "@/domain/repository";
import { ok } from "@/shared/result";
import { nowIso } from "@/shared/ids";

describe("Fix 12: Atomic createOrReuseJob & Event-Driven waitForIdle", () => {
  it("atomically deduplicates concurrent createOrReuseJob calls in memory", async () => {
    const store = new InMemoryAnalysisStore({ isScratch: true });
    const jobTemplate: AnalysisJobRecord = {
      jobId: "job-1",
      analysisId: null,
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      ownerId: "user-123",
      cacheKey: "org/repo@main",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Analysis queued.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      retryCount: 0,
      explanationRequested: false,
    };

    // Fire two simultaneous calls with different job IDs but same ownerId and cacheKey
    const [res1, res2] = await Promise.all([
      store.createOrReuseJob({ ...jobTemplate, jobId: "job-call-1" }),
      store.createOrReuseJob({ ...jobTemplate, jobId: "job-call-2" }),
    ]);

    // Exactly one call should have created the job, and the other should reuse it
    const createdCount = (res1.created ? 1 : 0) + (res2.created ? 1 : 0);
    expect(createdCount).toBe(1);

    // Both returned objects point to the same job
    expect(res1.job.jobId).toBe(res2.job.jobId);
  });

  it("re-queries and reuses job when Supabase encounters an active unique constraint conflict", async () => {
    const activeExistingJob: AnalysisJobRecord = {
      jobId: "existing-job-id",
      analysisId: null,
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      ownerId: "user-123",
      cacheKey: "org/repo@main",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Analysis queued.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      retryCount: 0,
      explanationRequested: false,
    };

    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      fetchCount++;
      const urlStr = url.toString();
      const method = init?.method ?? "GET";

      // 1. Initial findReusableJob GET
      if (method === "GET" && fetchCount === 1) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }

      // 2. createJob POST hits a 409 conflict (unique constraint violation from concurrent insert)
      if (method === "POST" && urlStr.includes("repo_story_jobs")) {
        return new Response(JSON.stringify({ message: "duplicate key value violates unique constraint 'repo_story_jobs_active_unique_idx'" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }

      // 3. Fallback findReusableJob GET after conflict returns the winning job
      if (method === "GET" && fetchCount >= 3) {
        return new Response(
          JSON.stringify([
            {
              job_id: activeExistingJob.jobId,
              analysis_id: null,
              repository_url: activeExistingJob.repositoryUrl,
              branch: activeExistingJob.branch,
              owner_id: activeExistingJob.ownerId,
              cache_key: activeExistingJob.cacheKey,
              status: activeExistingJob.status,
              stage: activeExistingJob.stage,
              progress: activeExistingJob.progress,
              message: activeExistingJob.message,
              created_at: activeExistingJob.createdAt,
              updated_at: activeExistingJob.updatedAt,
              expires_at: activeExistingJob.expiresAt,
              retry_count: 0,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });

    const repo = new SupabaseAnalysisJobRepository({
      url: "https://example.supabase.co",
      secretKey: "secret-key",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const result = await repo.createOrReuseJob({
      ...activeExistingJob,
      jobId: "new-raced-job-id",
    });

    expect(result.created).toBe(false);
    expect(result.job.jobId).toBe("existing-job-id");
  });

  it("waitForIdle uses event notification and resolves without busy-spinning", async () => {
    const store = new InMemoryAnalysisStore({ isScratch: true });
    const sleepSpy = vi.fn();

    const mockProvider: RepositoryProvider = {
      getSnapshot: async () => {
        // Simulate small work
        await new Promise((r) => setTimeout(r, 20));
        return ok({
          repository: {
            id: "repo",
            owner: "org",
            name: "repo",
            url: "https://github.com/org/repo",
            defaultBranch: "main",
            selectedBranch: "main",
            sizeBytes: 10,
            fileCount: 1,
          },
          files: [],
          coverage: {
            filesDiscovered: 0,
            filesAnalyzed: 0,
            filesSkippedByReason: { tooLarge: 0, unsupported: 0, limitReached: 0, parseFailure: 0, lfsPointer: 0, submodule: 0, unsupportedEncoding: 0, pathCollision: 0 },
          },
        });
      },
    };

    const runner = new AnalysisJobRunner(store, mockProvider, {
      sleep: sleepSpy,
      maxConcurrentJobs: 1,
    });

    // When already idle, resolves immediately without calling sleep(0)
    await runner.waitForIdle();
    expect(sleepSpy).not.toHaveBeenCalled();

    // Create a job and enqueue it
    const created = await store.createJob({
      jobId: "test-idle-job",
      analysisId: null,
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      ownerId: "user-1",
      cacheKey: "org/repo@main",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      retryCount: 0,
      explanationRequested: false,
    });

    runner.enqueue(created.jobId);

    // Wait for idle
    await runner.waitForIdle();

    // Verify: sleep(0) busy-spin was NEVER called
    expect(sleepSpy).not.toHaveBeenCalled();

    // Verify job reached completion
    const finalJob = await store.getJob(created.jobId);
    expect(finalJob?.status).toBe("completed");
  });
});
