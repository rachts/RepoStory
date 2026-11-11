import { describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "@/infrastructure/jobs/in-memory-job-queue";
import { InMemoryAnalysisStore } from "@/application/store";
import { JobWorker } from "@/application/jobs/job-worker";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { FixtureRepositoryProvider } from "@/infrastructure/providers/fixture-provider";
import type { AnalysisJobRecord } from "@/domain/analysis";

function createFixtureJob(id = "job-test-1"): AnalysisJobRecord {
  const now = new Date().toISOString();
  return {
    jobId: id,
    analysisId: null,
    repositoryUrl: "https://github.com/fixture/small-react",
    branch: "default",
    ownerId: "session-1",
    cacheKey: "cache-1",
    status: "queued",
    stage: "validating-input",
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    retryCount: 0,
    explanationRequested: false,
  };
}

describe("Workstream 1: Durable Job Queue & Worker", () => {
  it("enforces state machine: queued -> running -> succeeded", async () => {
    const fakeTime = 10000;
    const queue = new InMemoryJobQueue({ now: () => fakeTime });

    const item = await queue.enqueue("job-1");
    expect(item.status).toBe("queued");
    expect(item.jobId).toBe("job-1");

    const claimed = await queue.claim("worker-a");
    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe("running");
    expect(claimed?.workerId).toBe("worker-a");
    expect(claimed?.attempts).toBe(1);

    const hbSuccess = await queue.heartbeat("job-1", "worker-a");
    expect(hbSuccess).toBe(true);

    const hbWrongWorker = await queue.heartbeat("job-1", "worker-b");
    expect(hbWrongWorker).toBe(false);

    const completeSuccess = await queue.complete("job-1", "worker-a");
    expect(completeSuccess).toBe(true);

    const finalItem = await queue.get("job-1");
    expect(finalItem?.status).toBe("succeeded");

    const noMore = await queue.claim("worker-a");
    expect(noMore).toBeUndefined();
  });

  it("handles claim race: two concurrent workers never claim the same job", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("job-race-1");

    // Concurrent claims
    const [claimA, claimB] = await Promise.all([
      queue.claim("worker-1"),
      queue.claim("worker-2"),
    ]);

    // Exactly one worker got the job, the other got undefined
    const claimedWorkers = [claimA, claimB].filter(Boolean);
    expect(claimedWorkers).toHaveLength(1);
    expect(claimA ? "worker-1" : "worker-2").toBe(claimedWorkers[0]!.workerId);
  });

  it("reclaims abandoned job after heartbeat expiry", async () => {
    let fakeTime = 100_000;
    const queue = new InMemoryJobQueue({
      heartbeatTimeoutMs: 120_000,
      now: () => fakeTime,
    });

    await queue.enqueue("job-abandoned");
    const firstClaim = await queue.claim("worker-dead");
    expect(firstClaim?.workerId).toBe("worker-dead");

    // Advance time past heartbeat timeout (120s)
    fakeTime += 130_000;

    // Worker 2 should now reclaim the job
    const reclaimed = await queue.claim("worker-alive");
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.jobId).toBe("job-abandoned");
    expect(reclaimed?.workerId).toBe("worker-alive");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("retries with exponential backoff on retryable failures, and fails terminally after maxAttempts", async () => {
    let fakeTime = 10_000;
    const queue = new InMemoryJobQueue({
      maxAttempts: 2,
      retryBackoffMs: 1_000,
      now: () => fakeTime,
    });

    await queue.enqueue("job-retry");
    const claim1 = await queue.claim("w1");
    expect(claim1?.attempts).toBe(1);

    // First failure (retryable)
    await queue.fail("job-retry", "w1", { code: "TEMP_ERROR", message: "Network error", retryable: true });

    // Should transition back to queued with availableAt in the future
    const itemAfterFail = await queue.get("job-retry");
    expect(itemAfterFail?.status).toBe("queued");
    expect(new Date(itemAfterFail!.availableAt).getTime()).toBe(fakeTime + 1_000);

    // Before backoff expires, cannot be claimed
    const earlyClaim = await queue.claim("w2");
    expect(earlyClaim).toBeUndefined();

    // Advance time past backoff
    fakeTime += 1_500;

    const claim2 = await queue.claim("w2");
    expect(claim2).toBeDefined();
    expect(claim2?.attempts).toBe(2);

    // Second failure - maxAttempts (2) reached, should be terminal "failed"
    await queue.fail("job-retry", "w2", { code: "TEMP_ERROR", message: "Network error", retryable: true });
    const terminalItem = await queue.get("job-retry");
    expect(terminalItem?.status).toBe("failed");
  });

  it("immediately transitions to failed when error is not retryable", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("job-fatal");
    await queue.claim("w1");

    await queue.fail("job-fatal", "w1", { code: "FATAL_ERROR", message: "Bad syntax", retryable: false });
    const item = await queue.get("job-fatal");
    expect(item?.status).toBe("failed");
  });

  it("supports cancellation and prevents cancelled jobs from being processed", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("job-cancel");

    const cancelled = await queue.cancel("job-cancel");
    expect(cancelled).toBe(true);

    const item = await queue.get("job-cancel");
    expect(item?.status).toBe("cancelled");

    const claim = await queue.claim("w1");
    expect(claim).toBeUndefined();
  });

  it("refuses to initialize InMemoryJobQueue and InMemoryAnalysisStore in production without bypass", () => {
    const origEnv = process.env.NODE_ENV;
    const origAllowQ = process.env.ALLOW_IN_MEMORY_QUEUE;
    const origAllowS = process.env.ALLOW_IN_MEMORY_STORE;

    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.ALLOW_IN_MEMORY_QUEUE;
      delete process.env.ALLOW_IN_MEMORY_STORE;

      expect(() => new InMemoryJobQueue()).toThrowError(/not allowed in production/i);
      expect(() => new InMemoryAnalysisStore()).toThrowError(/not allowed in production/i);

      // With explicit bypass flag
      process.env.ALLOW_IN_MEMORY_QUEUE = "true";
      process.env.ALLOW_IN_MEMORY_STORE = "true";

      expect(() => new InMemoryJobQueue()).not.toThrow();
      expect(() => new InMemoryAnalysisStore()).not.toThrow();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
      process.env.ALLOW_IN_MEMORY_QUEUE = origAllowQ;
      process.env.ALLOW_IN_MEMORY_STORE = origAllowS;
    }
  });

  it("JobWorker claims, heartbeats, and processes jobs successfully", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const queue = new InMemoryJobQueue();
    const runner = new AnalysisJobRunner(store, new FixtureRepositoryProvider(), { maxConcurrentJobs: 1 });
    const worker = new JobWorker(queue, store, runner, {
      workerId: "test-worker",
      heartbeatIntervalMs: 50,
      pollIntervalMs: 20,
    });

    await store.createJob(createFixtureJob("job-worker-1"));
    await queue.enqueue("job-worker-1");

    const processed = await worker.tick();
    expect(processed?.jobId).toBe("job-worker-1");

    // Wait for async execution
    await runner.waitForIdle();

    const completed = await store.getJob("job-worker-1", "session-1");
    expect(completed?.status).toBe("completed");

    const queueItem = await queue.get("job-worker-1");
    expect(queueItem?.status).toBe("succeeded");
  });

  it("JobWorker catches fatal runner errors, updates repository to failed, and continues polling", async () => {
    const store = new InMemoryAnalysisStore({ maxAnalyses: 5, ttlMs: 60_000 });
    const queue = new InMemoryJobQueue();
    const failingRunner = {
      runNow: vi.fn().mockRejectedValue(new Error("Database connection severed")),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    } as unknown as AnalysisJobRunner;

    const worker = new JobWorker(queue, store, failingRunner, {
      workerId: "crash-test-worker",
      heartbeatIntervalMs: 50,
      pollIntervalMs: 20,
    });

    await store.createJob(createFixtureJob("job-crash-1"));
    await queue.enqueue("job-crash-1");

    const processed = await worker.tick();
    expect(processed?.jobId).toBe("job-crash-1");

    // Wait a brief tick for async processJob to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const failedJob = await store.getJob("job-crash-1", "session-1");
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.message).toContain("Worker crashed during validation: Database connection severed");
    expect(failedJob?.error?.code).toBe("WORKER_CRASHED");

    const queueItem = await queue.get("job-crash-1");
    expect(queueItem?.status).toBe("failed");
  });
});
