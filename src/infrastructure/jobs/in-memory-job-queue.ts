import type { JobQueue, JobQueueError, JobQueueItem, JobQueueOptions } from "@/application/jobs/job-queue";
import { AppError } from "@/domain/errors";
import { opaqueId } from "@/shared/ids";

export class InMemoryJobQueue implements JobQueue {
  private readonly items = new Map<string, JobQueueItem>();
  private readonly heartbeatTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly nowProvider: () => number;
  private claimLock = Promise.resolve();

  public constructor(options: JobQueueOptions & { now?: () => number } = {}) {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_IN_MEMORY_QUEUE !== "true") {
      throw new AppError({
        code: "INVALID_CONFIGURATION",
        message: "InMemoryJobQueue is not allowed in production. Set ALLOW_IN_MEMORY_QUEUE=true to override or configure SupabaseJobQueue.",
        retryable: false,
      });
    }

    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 1_000;
    this.nowProvider = options.now ?? Date.now;
  }

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.claimLock.then(fn, fn);
    this.claimLock = next.then(() => {}, () => {});
    return next;
  }

  public async enqueue(jobId: string, options?: { availableAt?: Date; maxAttempts?: number }): Promise<JobQueueItem> {
    return this.withLock(() => {
      const now = this.nowProvider();
      const existing = this.items.get(jobId);
      if (existing && (existing.status === "queued" || existing.status === "running")) {
        return structuredClone(existing);
      }

      const item: JobQueueItem = {
        id: opaqueId("qitem"),
        jobId,
        status: "queued",
        attempts: 0,
        maxAttempts: options?.maxAttempts ?? this.maxAttempts,
        availableAt: options?.availableAt ? options.availableAt.toISOString() : new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      this.items.set(jobId, item);
      return structuredClone(item);
    });
  }

  public async claim(workerId: string): Promise<JobQueueItem | undefined> {
    return this.withLock(() => {
      const now = this.nowProvider();
      const candidates: JobQueueItem[] = [];

      for (const item of this.items.values()) {
        const availableTime = new Date(item.availableAt).getTime();
        if (item.status === "queued" && availableTime <= now) {
          candidates.push(item);
        } else if (item.status === "running") {
          const lastHeartbeat = item.heartbeatAt ? new Date(item.heartbeatAt).getTime() : (item.lockedAt ? new Date(item.lockedAt).getTime() : 0);
          if (now - lastHeartbeat > this.heartbeatTimeoutMs) {
            candidates.push(item);
          }
        }
      }

      if (candidates.length === 0) return undefined;

      candidates.sort((a, b) => new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime());
      const chosen = candidates[0];
      if (!chosen) return undefined;

      chosen.status = "running";
      chosen.workerId = workerId;
      chosen.attempts += 1;
      const nowStr = new Date(now).toISOString();
      chosen.lockedAt = nowStr;
      chosen.heartbeatAt = nowStr;
      chosen.updatedAt = nowStr;

      return structuredClone(chosen);
    });
  }

  public async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    return this.withLock(() => {
      const item = this.items.get(jobId);
      if (!item || item.status !== "running" || item.workerId !== workerId) {
        return false;
      }
      const nowStr = new Date(this.nowProvider()).toISOString();
      item.heartbeatAt = nowStr;
      item.updatedAt = nowStr;
      return true;
    });
  }

  public async complete(jobId: string, workerId: string): Promise<boolean> {
    return this.withLock(() => {
      const item = this.items.get(jobId);
      if (!item || item.status !== "running" || item.workerId !== workerId) {
        return false;
      }
      const nowStr = new Date(this.nowProvider()).toISOString();
      item.status = "succeeded";
      item.updatedAt = nowStr;
      return true;
    });
  }

  public async fail(
    jobId: string,
    workerId: string,
    error: JobQueueError,
    retryAt?: Date,
  ): Promise<boolean> {
    return this.withLock(() => {
      const item = this.items.get(jobId);
      if (!item || item.status !== "running" || item.workerId !== workerId) {
        return false;
      }
      const now = this.nowProvider();
      const nowStr = new Date(now).toISOString();
      item.error = error;
      item.updatedAt = nowStr;

      if (error.retryable && item.attempts < item.maxAttempts) {
        item.status = "queued";
        item.workerId = undefined;
        item.lockedAt = undefined;
        item.heartbeatAt = undefined;
        const nextTime = retryAt ? retryAt.getTime() : now + this.retryBackoffMs * 2 ** (item.attempts - 1);
        item.availableAt = new Date(nextTime).toISOString();
      } else {
        item.status = "failed";
      }
      return true;
    });
  }

  public async retry(jobId: string): Promise<boolean> {
    return this.withLock(() => {
      const item = this.items.get(jobId);
      if (!item || item.status !== "failed" || !item.error?.retryable || item.attempts >= item.maxAttempts) {
        return false;
      }
      const nowStr = new Date(this.nowProvider()).toISOString();
      item.status = "queued";
      item.workerId = undefined;
      item.lockedAt = undefined;
      item.heartbeatAt = undefined;
      item.availableAt = nowStr;
      item.updatedAt = nowStr;
      return true;
    });
  }

  public async cancel(jobId: string): Promise<boolean> {
    return this.withLock(() => {
      const item = this.items.get(jobId);
      if (!item || item.status === "succeeded" || item.status === "cancelled") {
        return false;
      }
      const nowStr = new Date(this.nowProvider()).toISOString();
      item.status = "cancelled";
      item.updatedAt = nowStr;
      return true;
    });
  }

  public async get(jobId: string): Promise<JobQueueItem | undefined> {
    const item = this.items.get(jobId);
    return item ? structuredClone(item) : undefined;
  }

  public async listRunning(): Promise<JobQueueItem[]> {
    return [...this.items.values()]
      .filter((i) => i.status === "running")
      .map((i) => structuredClone(i));
  }
}
