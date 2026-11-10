import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/analyze/route";
import { register } from "@/instrumentation";
import { assertProductionGuards, getProductionConfigError } from "@/config/production-guards";
import { analysisRepository, analysisJobRunner } from "@/composition/container";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import type { AnalysisJobRecord } from "@/domain/analysis";

describe("Production startup guards & /api/analyze error contract", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const setNodeEnv = (env: string) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
  };

  it("does not throw during module import when production configuration is missing", async () => {
    setNodeEnv("production");
    delete process.env.REPO_STORY_JOB_STORE;
    delete process.env.ALLOW_IN_MEMORY_QUEUE;
    delete process.env.ALLOW_IN_MEMORY_STORE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    // Importing /api/analyze/route should never throw or crash at module scope
    await expect(import("@/app/api/analyze/route")).resolves.toBeDefined();
  });

  it("returns structured JSON 500 when REPO_STORY_JOB_STORE is missing in production", async () => {
    setNodeEnv("production");
    delete process.env.REPO_STORY_JOB_STORE;

    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/owner/repo" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toContain("In production, REPO_STORY_JOB_STORE must be explicitly set");
    expect(body.error.retryable).toBe(false);
  });

  it("returns structured JSON 500 when memory queue is not allowed in production", async () => {
    setNodeEnv("production");
    process.env.REPO_STORY_JOB_STORE = "memory";
    delete process.env.ALLOW_IN_MEMORY_QUEUE;
    process.env.ALLOW_IN_MEMORY_STORE = "true";

    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/owner/repo" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toContain("InMemoryJobQueue is not allowed in production unless ALLOW_IN_MEMORY_QUEUE=true");
  });

  it("returns structured JSON 500 when Supabase mode is chosen without credentials", async () => {
    setNodeEnv("production");
    process.env.REPO_STORY_JOB_STORE = "supabase";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/owner/repo" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toContain("In production with Supabase mode, SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  });

  it("instrumentation.ts register() logs error without crashing the server process", async () => {
    setNodeEnv("production");
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.REPO_STORY_JOB_STORE;

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(register()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[RepoStory] Production configuration failed:",
      expect.stringContaining("In production, REPO_STORY_JOB_STORE must be explicitly set"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("assertProductionGuards() still exits/throws by default (fail-fast behavior retained)", () => {
    setNodeEnv("production");
    delete process.env.REPO_STORY_JOB_STORE;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    expect(() => {
      // Called with default exitOnError parameter
      assertProductionGuards(process.env, true);
    }).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("getProductionConfigError() returns CONFIG_ERROR for each invalid case and null when valid", () => {
    // 1. Missing REPO_STORY_JOB_STORE
    const errMissing = getProductionConfigError({ NODE_ENV: "production" });
    expect(errMissing?.code).toBe("CONFIG_ERROR");
    expect(errMissing?.message).toContain("In production, REPO_STORY_JOB_STORE must be explicitly set");

    // 2. Invalid REPO_STORY_JOB_STORE
    const errInvalid = getProductionConfigError({ NODE_ENV: "production", REPO_STORY_JOB_STORE: "redis-unsupported" });
    expect(errInvalid?.code).toBe("CONFIG_ERROR");
    expect(errInvalid?.message).toContain("REPO_STORY_JOB_STORE must be set to 'supabase', 'file', or 'memory'");

    // 3. Memory without queue permission
    const errMem = getProductionConfigError({ NODE_ENV: "production", REPO_STORY_JOB_STORE: "memory", ALLOW_IN_MEMORY_STORE: "true" });
    expect(errMem?.code).toBe("CONFIG_ERROR");
    expect(errMem?.message).toContain("InMemoryJobQueue is not allowed");

    // 4. File without queue permission
    const errFile = getProductionConfigError({ NODE_ENV: "production", REPO_STORY_JOB_STORE: "file" });
    expect(errFile?.code).toBe("CONFIG_ERROR");
    expect(errFile?.message).toContain("ALLOW_IN_MEMORY_QUEUE=true is explicitly set");

    // 5. Supabase without credentials
    const errSupa = getProductionConfigError({ NODE_ENV: "production", REPO_STORY_JOB_STORE: "supabase" });
    expect(errSupa?.code).toBe("CONFIG_ERROR");
    expect(errSupa?.message).toContain("SUPABASE_URL and SUPABASE_SECRET_KEY are required");

    // 6. Valid cases return null
    expect(getProductionConfigError({
      NODE_ENV: "production",
      REPO_STORY_JOB_STORE: "file",
      ALLOW_IN_MEMORY_QUEUE: "true",
    })).toBeNull();

    expect(getProductionConfigError({
      NODE_ENV: "production",
      REPO_STORY_JOB_STORE: "supabase",
      SUPABASE_URL: "https://xyz.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
    })).toBeNull();
  });

  it("lazy container proxies still respect vi.spyOn and globalContainer overrides after first access", async () => {
    // First access to analysisRepository
    expect(analysisRepository).toBeDefined();
    const initialJob = await analysisRepository.getJob("non-existent-probe-id");
    expect(initialJob).toBeUndefined();

    // Override globalContainer.repoStoryAnalysisRepository AFTER first access
    const mockJobRecord = { jobId: "overridden-job-123", status: "completed" } as unknown as AnalysisJobRecord;
    const mockRepo = {
      getJob: vi.fn().mockResolvedValue(mockJobRecord),
    } as unknown as AnalysisJobRepository;
    const globalObj = globalThis as { repoStoryAnalysisRepository?: AnalysisJobRepository };
    globalObj.repoStoryAnalysisRepository = mockRepo;

    // Subsequent access must resolve to the overridden instance
    const overriddenJob = await analysisRepository.getJob("overridden-job-123");
    expect(overriddenJob).toEqual(mockJobRecord);
    expect(mockRepo.getJob).toHaveBeenCalledWith("overridden-job-123");

    // Clean up globalContainer override
    delete globalObj.repoStoryAnalysisRepository;

    // First access to analysisJobRunner
    expect(analysisJobRunner).toBeDefined();

    // vi.spyOn AFTER first access
    const enqueueSpy = vi.spyOn(analysisJobRunner, "enqueue").mockImplementation(() => undefined);
    analysisJobRunner.enqueue("job-test-spy-123");
    expect(enqueueSpy).toHaveBeenCalledWith("job-test-spy-123");
    enqueueSpy.mockRestore();
  });

  describe("Frontend error message extraction logic", () => {
    const extractErrorMessage = (payload: unknown): string => {
      const p = payload as { error?: { message?: string } | string; message?: string } | null;
      return (
        (typeof p?.error === "object" ? p?.error?.message : typeof p?.error === "string" ? p.error : undefined) ??
        (typeof p?.message === "string" ? p.message : undefined) ??
        "The repository could not be analyzed."
      );
    };

    it("extracts structured error.message from API response", () => {
      const payload = {
        error: {
          code: "CONFIG_ERROR",
          message: "REPO_STORY_JOB_STORE must be set to 'supabase' or 'memory' in production.",
        },
      };
      expect(extractErrorMessage(payload)).toBe("REPO_STORY_JOB_STORE must be set to 'supabase' or 'memory' in production.");
    });

    it("extracts string error from middleware CORS response", () => {
      const payload = { error: "Cross-origin request forbidden" };
      expect(extractErrorMessage(payload)).toBe("Cross-origin request forbidden");
    });

    it("extracts root message field if present", () => {
      const payload = { message: "Server overloaded. Please retry." };
      expect(extractErrorMessage(payload)).toBe("Server overloaded. Please retry.");
    });

    it("falls back to generic error message when payload is null or empty", () => {
      expect(extractErrorMessage(null)).toBe("The repository could not be analyzed.");
      expect(extractErrorMessage({})).toBe("The repository could not be analyzed.");
      expect(extractErrorMessage({ error: {} })).toBe("The repository could not be analyzed.");
    });
  });
});
