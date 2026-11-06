export type JobQueueStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobQueueError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface JobQueueItem {
  id: string;
  jobId: string;
  status: JobQueueStatus;
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  lockedAt?: string;
  heartbeatAt?: string;
  availableAt: string;
  error?: JobQueueError;
  createdAt: string;
  updatedAt: string;
}

export interface JobQueueOptions {
  heartbeatTimeoutMs?: number; // default 120_000 (2 minutes)
  maxAttempts?: number; // default 3
  retryBackoffMs?: number; // default 1_000
}

/**
 * Port for durable job execution queue.
 * Implements state machine: queued -> running -> succeeded | failed | cancelled
 */
export interface JobQueue {
  enqueue(jobId: string, options?: { availableAt?: Date; maxAttempts?: number }): Promise<JobQueueItem>;
  claim(workerId: string): Promise<JobQueueItem | undefined>;
  heartbeat(jobId: string, workerId: string): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    error: JobQueueError,
    retryAt?: Date,
  ): Promise<boolean>;
  retry(jobId: string): Promise<boolean>;
  cancel(jobId: string): Promise<boolean>;
  get(jobId: string): Promise<JobQueueItem | undefined>;
  listRunning?(): Promise<JobQueueItem[]>;
}
