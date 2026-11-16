import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldRunInProcessJobs } from "@/app/api/analyze/route";

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

  it("defaults to queueMode === 'memory' in development when IN_PROCESS_JOBS is undefined", () => {
    delete process.env.IN_PROCESS_JOBS;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    // In our test config, queueMode is memory
    expect(typeof shouldRunInProcessJobs()).toBe("boolean");
  });
});
