import type { JobQueue, JobQueueError, JobQueueItem, JobQueueOptions } from "@/application/jobs/job-queue";
import { AppError } from "@/domain/errors";
import { opaqueId } from "@/shared/ids";

interface SupabaseJobQueueOptions extends JobQueueOptions {
  url?: string;
  secretKey?: string;
  fetchImpl?: typeof fetch;
}

export class SupabaseJobQueue implements JobQueue {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SupabaseJobQueueOptions = {}) {
    this.baseUrl = `${options.url?.replace(/\/$/, "") ?? ""}/rest/v1`;
    this.secretKey = options.secretKey ?? "";
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(prefer = "return=representation"): HeadersInit {
    return {
      apikey: this.secretKey,
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    };
  }

  private rowToItem(row: Record<string, unknown>): JobQueueItem {
    return {
      id: String(row.id ?? row.job_id),
      jobId: String(row.job_id),
      status: row.status as JobQueueItem["status"],
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? this.maxAttempts),
      workerId: typeof row.worker_id === "string" ? row.worker_id : undefined,
      lockedAt: typeof row.locked_at === "string" ? row.locked_at : undefined,
      heartbeatAt: typeof row.heartbeat_at === "string" ? row.heartbeat_at : undefined,
      availableAt: String(row.available_at ?? row.created_at),
      error: (row.error as JobQueueError) ?? undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public async enqueue(jobId: string, options?: { availableAt?: Date; maxAttempts?: number }): Promise<JobQueueItem> {
    const now = new Date().toISOString();
    const item: Record<string, unknown> = {
      id: opaqueId("qitem"),
      job_id: jobId,
      status: "queued",
      attempts: 0,
      max_attempts: options?.maxAttempts ?? this.maxAttempts,
      available_at: options?.availableAt ? options.availableAt.toISOString() : now,
      created_at: now,
      updated_at: now,
    };

    const response = await this.fetchImpl(`${this.baseUrl}/repo_story_job_queue`, {
      method: "POST",
      headers: { ...this.headers(), Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify(item),
    });

    if (!response.ok) {
      throw new AppError({
        code: "JOB_QUEUE_UNAVAILABLE",
        message: `Failed to enqueue job in SupabaseJobQueue (${response.status})`,
        retryable: true,
      });
    }

    const rows = (await response.json()) as Record<string, unknown>[];
    return this.rowToItem(rows[0] ?? item);
  }

  public async claim(workerId: string): Promise<JobQueueItem | undefined> {
    const timeoutSeconds = Math.max(1, Math.floor(this.heartbeatTimeoutMs / 1000));
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/rpc/claim_queue_job`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ p_worker_id: workerId, p_timeout_seconds: timeoutSeconds }),
      });

      if (response.ok) {
        const rows = (await response.json()) as Record<string, unknown>[];
        if (rows && rows.length > 0 && rows[0]) {
          return this.rowToItem(rows[0]);
        }
        return undefined;
      }
    } catch {
      // Fallback to REST queries if RPC is not present
    }

    const now = new Date().toISOString();
    const expiredHeartbeat = new Date(Date.now() - this.heartbeatTimeoutMs).toISOString();

    const fetchUrl = `${this.baseUrl}/repo_story_job_queue?or=(and(status.eq.queued,available_at.lte.${now}),and(status.eq.running,heartbeat_at.lt.${expiredHeartbeat}))&order=available_at.asc&limit=1`;
    const getRes = await this.fetchImpl(fetchUrl, {
      method: "GET",
      headers: this.headers(),
    });

    if (!getRes.ok) return undefined;
    const candidates = (await getRes.json()) as Record<string, unknown>[];
    if (!candidates || candidates.length === 0 || !candidates[0]) return undefined;

    const target = candidates[0];
    const updateRes = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${target.job_id}&updated_at=eq.${target.updated_at}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          status: "running",
          worker_id: workerId,
          attempts: Number(target.attempts ?? 0) + 1,
          locked_at: now,
          heartbeat_at: now,
          updated_at: now,
        }),
      },
    );

    if (!updateRes.ok) return undefined;
    const updated = (await updateRes.json()) as Record<string, unknown>[];
    return updated[0] ? this.rowToItem(updated[0]) : undefined;
  }

  public async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}&worker_id=eq.${workerId}&status=eq.running`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          heartbeat_at: now,
          updated_at: now,
        }),
      },
    );

    if (!response.ok) return false;
    const rows = (await response.json()) as Record<string, unknown>[];
    return rows.length > 0;
  }

  public async complete(jobId: string, workerId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}&worker_id=eq.${workerId}&status=eq.running`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          status: "succeeded",
          updated_at: now,
        }),
      },
    );

    if (!response.ok) return false;
    const rows = (await response.json()) as Record<string, unknown>[];
    return rows.length > 0;
  }

  public async fail(
    jobId: string,
    workerId: string,
    error: JobQueueError,
    retryAt?: Date,
  ): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current || current.status !== "running" || current.workerId !== workerId) {
      return false;
    }

    const now = Date.now();
    const nowStr = new Date(now).toISOString();
    const shouldRetry = error.retryable && current.attempts < current.maxAttempts;

    const patch: Record<string, unknown> = {
      error,
      updated_at: nowStr,
    };

    if (shouldRetry) {
      patch.status = "queued";
      patch.worker_id = null;
      patch.locked_at = null;
      patch.heartbeat_at = null;
      const nextTime = retryAt ? retryAt.getTime() : now + this.retryBackoffMs * 2 ** (current.attempts - 1);
      patch.available_at = new Date(nextTime).toISOString();
    } else {
      patch.status = "failed";
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}&worker_id=eq.${workerId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify(patch),
      },
    );

    return response.ok;
  }

  public async retry(jobId: string): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current || current.status !== "failed" || !current.error?.retryable || current.attempts >= current.maxAttempts) {
      return false;
    }

    const nowStr = new Date().toISOString();
    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          status: "queued",
          worker_id: null,
          locked_at: null,
          heartbeat_at: null,
          available_at: nowStr,
          updated_at: nowStr,
        }),
      },
    );

    return response.ok;
  }

  public async cancel(jobId: string): Promise<boolean> {
    const nowStr = new Date().toISOString();
    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}&status=not.in.(succeeded,cancelled)`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          status: "cancelled",
          updated_at: nowStr,
        }),
      },
    );

    return response.ok;
  }

  public async get(jobId: string): Promise<JobQueueItem | undefined> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/repo_story_job_queue?job_id=eq.${jobId}&limit=1`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );

    if (!response.ok) return undefined;
    const rows = (await response.json()) as Record<string, unknown>[];
    return rows[0] ? this.rowToItem(rows[0]) : undefined;
  }
}
