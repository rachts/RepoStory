import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/analyze/route";
import { register } from "@/instrumentation";

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
