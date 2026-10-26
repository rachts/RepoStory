import { describe, expect, it, vi } from "vitest";
import { SupabaseAnalysisJobRepository } from "@/infrastructure/jobs/supabase-analysis-job-repository";
import type { AnalysisJobRecord } from "@/domain/analysis";

const job: AnalysisJobRecord = {
  jobId: "job-supabase",
  analysisId: null,
  repositoryUrl: "https://github.com/fixture/repo",
  branch: "default",
  ownerId: "session-supabase",
  cacheKey: "cache-supabase",
  status: "queued",
  stage: "validating-input",
  progress: 0,
  message: "Queued",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  retryCount: 0,
  explanationRequested: false,
};

describe("Supabase analysis job repository", () => {
  it("writes server-side rows through the REST API and maps them back to domain jobs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("https://project.supabase.co/rest/v1/repo_story_jobs");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sb_secret_test");
      if (init?.method === "POST") return new Response(null, { status: 201 });
      return Response.json([{
        job_id: job.jobId,
        analysis_id: null,
        repository_url: job.repositoryUrl,
        branch: job.branch,
        owner_id: job.ownerId,
        cache_key: job.cacheKey,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        message: job.message,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        expires_at: job.expiresAt,
        retry_count: job.retryCount,
        explanation_requested: false,
      }]);
    });
    const repository = new SupabaseAnalysisJobRepository({ url: "https://project.supabase.co", secretKey: "sb_secret_test", fetchImpl });

    await expect(repository.createJob(job)).resolves.toEqual(job);
    await expect(repository.getJob(job.jobId, job.ownerId)).resolves.toEqual(job);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("turns Supabase HTTP failures into safe storage errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("permission denied", { status: 401 }));
    const repository = new SupabaseAnalysisJobRepository({ url: "https://project.supabase.co", secretKey: "sb_secret_test", fetchImpl });

    await expect(repository.createJob(job)).rejects.toMatchObject({
      code: "ANALYSIS_STORAGE_UNAVAILABLE",
      retryable: true,
    });
  });
});
