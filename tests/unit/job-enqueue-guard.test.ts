import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shouldRunInProcessJobs } from "@/application/jobs/job-execution-mode";
import { POST as analyzePost } from "@/app/api/analyze/route";
import { analysisJobRunner } from "@/composition/container";

describe("Job Enqueue Guard (shouldRunInProcessJobs)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when IN_PROCESS_JOBS is explicitly set to 'true'", () => {
    process.env.IN_PROCESS_JOBS = "true";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(shouldRunInProcessJobs()).toBe(true);
  });

  it("returns false when IN_PROCESS_JOBS is explicitly set to 'false'", () => {
    process.env.IN_PROCESS_JOBS = "false";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(shouldRunInProcessJobs()).toBe(false);
  });

  it("returns false in production when IN_PROCESS_JOBS is undefined", () => {
    delete process.env.IN_PROCESS_JOBS;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(shouldRunInProcessJobs()).toBe(false);
  });

  it("defaults to true in development when IN_PROCESS_JOBS is undefined", () => {
    delete process.env.IN_PROCESS_JOBS;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(shouldRunInProcessJobs()).toBe(true);
  });

  it("defaults to true in test environment when IN_PROCESS_JOBS is undefined", () => {
    delete process.env.IN_PROCESS_JOBS;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    expect(shouldRunInProcessJobs()).toBe(true);
  });

  it("re-enqueues into analysisJobRunner when re-submitting an existing queued job", async () => {
    process.env.IN_PROCESS_JOBS = "true";
    const enqueueSpy = vi.spyOn(analysisJobRunner, "enqueue").mockImplementation(() => {});

    // Create an initial queued job
    const req1 = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-repo-story-session": "session-dedup-resubmit" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/octocat/Hello-World" }),
    });
    const res1 = await analyzePost(req1);
    expect(res1.status).toBe(202);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    // Call analyze again for the same repository - it reuses the queued job but re-enqueues to runner
    const req2 = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-repo-story-session": "session-dedup-resubmit" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/octocat/Hello-World" }),
    });
    const res2 = await analyzePost(req2);
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { deduplicated: boolean; status: string };
    expect(body2.deduplicated).toBe(true);
    expect(body2.status).toBe("queued");
    expect(enqueueSpy).toHaveBeenCalledTimes(2);

    enqueueSpy.mockRestore();
  });
});
